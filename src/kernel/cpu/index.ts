/**
 * 文件摘要：kernel.cpu，CPU 分层准入、每 tick 预算与平滑计量（设计见 docs/design/kernel/cpu.md，架构设计 5.2、5.3）。
 *
 * 所属位置：src/kernel/cpu/，kernel 内部模块，只由 kernel.lifecycle 与 kernel.context 使用。
 * 每 tick 流程：beginTick 计算预算 B、收尾预留 R 与两个读数上限 → 普通模块 setup 之后 admit 对全部进程判定一次
 * （准入、空闲、落选），结果在本 tick 内固定 → 阶段循环由 lifecycle 在钩子之间读数，把耗用累加到进程的 spent →
 * settle 用本 tick 样本更新平滑耗用并汇总各层耗用。
 * 判定（judge）先递归判定进程的所属模块与 requires 依赖：落选者排在前面时，依赖可能尚未判定（审计 LC-02）。
 * 依赖"空闲"（层条件不满足）不阻挡依赖方，"落选"才阻挡。因预算落选时把预计值乘以 1 − α，
 * 使按剩余预算自适应的长计算在预算收缩后仍能重新准入（审计 LC-03）。
 * 状态：预算与读数上限保存在 createCpu 的闭包中；每个进程的平滑耗用、连续落选次数、判定结果与本 tick 耗用
 * 保存在进程运行记录上（CpuNode），只存于 heap，global reset 与软重置后从预热开始。
 */
import type { CpuBudget, Tier } from '@/contracts/cpu';
import { hashString } from '@/lib/hash';

/** bucket 回补目标（附录 B）。 */
export const BUCKET_TARGET = 5000;
/** 透支回落时长：bucket 高于目标时按此 tick 数摊销透支（附录 B）。 */
export const BUCKET_DRAIN = 1000;
/** 规划层的 bucket 阈值（附录 B）。 */
export const PLANNING_BUCKET = 1500;
/** 维护层进程的执行周期（tick），按进程键错峰。 */
export const MAINTENANCE_PERIOD = 10;
/** 平滑系数：每个新样本的权重。 */
export const CPU_EMA_ALPHA = 0.2;
/** 收尾预留占 B 的比例与下限（附录 B）。 */
export const RESERVE_RATIO = 0.1;
export const RESERVE_MIN = 2;

/** 判定结果：未判定、准入、空闲（层条件不满足或不可运行）、落选（预算或依赖）。 */
export const VERDICT_NONE = 0;
export const VERDICT_ADMIT = 1;
export const VERDICT_IDLE = 2;
export const VERDICT_REJECT = 3;
export type Verdict = typeof VERDICT_NONE | typeof VERDICT_ADMIT | typeof VERDICT_IDLE | typeof VERDICT_REJECT;

/** 预算计算所需的 CPU 读数；GamePort 满足此接口。 */
export interface CpuPort {
  /**
   * @description 当前 tick。
   * @returns Game.time。
   */
  time(): number;
  /**
   * @description 本 tick 已用 CPU。
   * @returns Game.cpu.getUsed()。
   */
  cpuUsed(): number;
  /**
   * @description 每 tick 的 CPU 额度。
   * @returns Game.cpu.limit。
   */
  limit(): number;
  /**
   * @description 本 tick 可用的 CPU 上限。
   * @returns Game.cpu.tickLimit。
   */
  tickLimit(): number;
  /**
   * @description 当前 bucket。
   * @returns Game.cpu.bucket。
   */
  bucket(): number;
}

/**
 * 参与准入的进程。静态模块与动态实例的运行记录实现此接口；字段按固定顺序在构造时初始化（12.1）。
 * 计量字段只由 kernel.cpu 与 lifecycle 修改。
 */
export interface CpuNode {
  /** 进程键：模块为模块 id，实例为 `<模块 id>:<实例键>`；用于维护层错峰。 */
  readonly key: string;
  readonly tier: Tier;
  /** 实例的所属模块；模块为 undefined。 */
  readonly owner: CpuNode | undefined;
  /** requires 指向的模块（实例为空）；由 lifecycle 在构造后填入。 */
  readonly deps: readonly CpuNode[];
  /** 本 tick 是否可运行（已就绪、未熔断、未暂停、依赖可运行）；由 lifecycle 在 admit 之前计算。 */
  runnable: boolean;
  /** 平滑耗用，即准入时的预计耗用；sampled 为 false 时按 0 计。 */
  cost: number;
  /** 是否已有样本。 */
  sampled: boolean;
  /** 连续落选次数。 */
  starve: number;
  /** 本 tick 的判定结果。 */
  verdict: Verdict;
  /** 本 tick 已计量的耗用，settle 后清零。 */
  spent: number;
}

/** 本 tick 的预算与计量摘要，供 stats 与运维读取。 */
export interface CpuTickSummary {
  /** 每 tick 预算 B。 */
  readonly budget: number;
  /** 收尾预留 R。 */
  readonly reserve: number;
  /** { [层级]: 本 tick 计量到的耗用 }。 */
  readonly tiers: Readonly<Record<Tier, number>>;
  /** 本 tick 被准入与落选的进程数。 */
  readonly admitted: number;
  readonly rejected: number;
}

/** kernel 内部接口。 */
export interface CpuHost {
  /** { [层级]: 预算视图 }，对象在实例内稳定，注入到进程上下文。 */
  readonly budgets: Readonly<Record<Tier, CpuBudget>>;
  /**
   * @description tick 起点：计算 B、R 与两个读数上限，清零本 tick 的汇总。
   * @returns 无返回值。
   */
  beginTick(): void;
  /**
   * @description 对全部进程判定一次（cpu.md 第 3.2 节）。nodes 为执行顺序；不可运行的进程判为空闲。
   * @param nodes 全部进程运行记录，按执行顺序（模块在前、其实例随后）。
   * @returns 无返回值；结果写入各节点的 verdict。
   */
  admit(nodes: readonly CpuNode[]): void;
  /**
   * @description tick 收尾：以本 tick 的 spent 更新被准入进程的平滑耗用，汇总各层耗用，清零 spent。
   * @param nodes 与 admit 相同的进程集合。
   * @returns 无返回值。
   */
  settle(nodes: readonly CpuNode[]): void;
  /**
   * @description 生存层的读数上限 tickLimit − R；阶段执行中读数到达它时，lifecycle 跳过剩余的非生存层钩子。
   * @returns CPU 读数上限。
   */
  hardEnd(): number;
  /**
   * @description 最近一次 settle 的摘要。
   * @returns 预算、预留、各层耗用与准入计数。
   */
  summary(): CpuTickSummary;
}

/** 三个非生存层按判定顺序排列。 */
const JUDGED_TIERS: readonly Tier[] = ['economy', 'maintenance', 'planning'];

/**
 * @description 把数限制在区间内。
 * @param value 输入。
 * @param low 下界。
 * @param high 上界；小于下界时以下界为准。
 * @returns 限制后的值。
 */
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/**
 * @description 创建 kernel.cpu；构造不读取平台。
 * @param port CPU 读数端口。
 * @returns 每 tick 由 lifecycle 驱动的宿主接口。
 */
export const createCpu = (port: CpuPort): CpuHost => {
  let budget = 0;
  let reserve = RESERVE_MIN;
  // 两个读数上限：非生存层不越过 poolEnd，生存层不越过 hardEnd（cpu.md 第 2 节）；首个 beginTick 之前为 0。
  let poolEnd = 0;
  let hardEnd = 0;
  // admit 期间的预计读数：当前读数 + 已准入进程的预计耗用。
  let expected = 0;
  let time = 0;
  let bucket = 0;
  let summary: CpuTickSummary = Object.freeze({ budget: 0, reserve: RESERVE_MIN,
    tiers: Object.freeze({ survival: 0, economy: 0, maintenance: 0, planning: 0 }), admitted: 0, rejected: 0 });

  /**
   * @description 创建一个层级的预算视图，契约见 CpuBudget。
   * @param tier 层级。
   * @returns 预算视图。
   */
  const view = (tier: Tier): CpuBudget => {
    const survival = tier === 'survival';
    /**
     * @description 本层剩余可用 CPU：生存层到 hardEnd，其余到 poolEnd。
     * @returns 剩余 CPU，可能为负。
     */
    const remaining = (): number => (survival ? hardEnd : poolEnd) - port.cpuUsed();
    return Object.freeze({
      tier, remaining,
      /**
       * @description 剩余不大于 0 时让出。
       * @returns 应让出时为 true。
       */
      shouldYield: () => remaining() <= 0,
    });
  };
  const budgets = Object.freeze({ survival: view('survival'), economy: view('economy'),
    maintenance: view('maintenance'), planning: view('planning') });

  /**
   * @description 判断进程是否满足所在层的层条件（cpu.md 第 3.2 节的表）。
   * @param node 进程。
   * @returns 满足时为 true；不满足时本 tick 空闲。
   */
  const layerOk = (node: CpuNode): boolean => {
    if (node.tier === 'maintenance') return (time + hashString(node.key)) % MAINTENANCE_PERIOD === 0;
    if (node.tier === 'planning') return bucket >= PLANNING_BUCKET;
    return true;
  };

  /**
   * @description 记为落选并累计连续落选次数；因自身预算落选时衰减预计值（审计 LC-03）。
   * @param node 进程。
   * @param own 是否因自身预算落选（而不是依赖落选）。
   * @returns 落选。
   */
  const reject = (node: CpuNode, own: boolean): Verdict => {
    node.verdict = VERDICT_REJECT;
    node.starve += 1;
    if (own && node.sampled) node.cost *= 1 - CPU_EMA_ALPHA;
    return VERDICT_REJECT;
  };

  /**
   * @description 判定一个进程；每个进程每 tick 只判定一次。先递归判定所属模块与 requires 依赖：
   * 依赖成环已被清单校验拒绝，递归必然终止。
   * @param node 进程。
   * @returns 判定结果。
   */
  const judge = (node: CpuNode): Verdict => {
    if (node.verdict !== VERDICT_NONE) return node.verdict;
    if (!layerOk(node)) { node.verdict = VERDICT_IDLE; return VERDICT_IDLE; }
    if (node.owner !== undefined && judge(node.owner) === VERDICT_REJECT) return reject(node, false);
    for (let i = 0; i < node.deps.length; i += 1) {
      if (judge(node.deps[i]) === VERDICT_REJECT) return reject(node, false);
    }
    const cost = node.sampled ? node.cost : 0;
    if (expected + cost > poolEnd) return reject(node, true);
    expected += cost;
    node.starve = 0;
    node.verdict = VERDICT_ADMIT;
    return VERDICT_ADMIT;
  };

  return {
    budgets,
    /**
     * @description 计算本 tick 的预算，语义见 CpuHost.beginTick。
     * @returns 无返回值。
     */
    beginTick() {
      time = port.time();
      bucket = port.bucket();
      const tickLimit = port.tickLimit();
      // 额度不是有限数时（私服可能不限制）以 tickLimit 为额度，避免 B 与上限成为 NaN。
      const raw = port.limit();
      const limit = Number.isFinite(raw) ? raw : tickLimit;
      budget = limit + clamp((bucket - BUCKET_TARGET) / BUCKET_DRAIN, -limit * 0.2, tickLimit - limit);
      reserve = Math.max(RESERVE_MIN, budget * RESERVE_RATIO);
      poolEnd = budget - reserve;
      hardEnd = tickLimit - reserve;
    },
    /**
     * @description 判定全部进程，语义见 CpuHost.admit。
     * @param nodes 全部进程，按执行顺序。
     * @returns 无返回值。
     */
    admit(nodes) {
      expected = port.cpuUsed();
      for (const node of nodes) {
        // 上一 tick 中途新增的实例不在当时的列表里，其耗用没有被 settle 清零；这里统一清零，样本只含本 tick。
        node.spent = 0;
        node.verdict = node.runnable ? VERDICT_NONE : VERDICT_IDLE;
        // 生存层总是准入，其预计耗用先计入 expected，保证其他层的预检扣除了它们。
        if (node.runnable && node.tier === 'survival') {
          node.verdict = VERDICT_ADMIT;
          expected += node.sampled ? node.cost : 0;
        }
      }
      for (const tier of JUDGED_TIERS) {
        // 连续落选的进程先占用预算（从多到少，同次数保持执行顺序）；进程很少落选时此数组为空，不排序。
        const starved: CpuNode[] = [];
        for (const node of nodes) if (node.tier === tier && node.starve > 0 && node.verdict === VERDICT_NONE) starved.push(node);
        if (starved.length > 1) starved.sort((a, b) => b.starve - a.starve);
        for (const node of starved) judge(node);
        for (const node of nodes) if (node.tier === tier) judge(node);
      }
    },
    /**
     * @description 更新平滑耗用并汇总，语义见 CpuHost.settle。
     * @param nodes 全部进程。
     * @returns 无返回值。
     */
    settle(nodes) {
      const tiers: Record<Tier, number> = { survival: 0, economy: 0, maintenance: 0, planning: 0 };
      let admitted = 0;
      let rejected = 0;
      for (const node of nodes) {
        if (node.verdict === VERDICT_ADMIT) {
          admitted += 1;
          const sample = node.spent;
          node.cost = node.sampled ? node.cost + CPU_EMA_ALPHA * (sample - node.cost) : sample;
          node.sampled = true;
          tiers[node.tier] += sample;
        } else if (node.verdict === VERDICT_REJECT) {
          rejected += 1;
        }
        node.spent = 0;
      }
      summary = Object.freeze({ budget, reserve, tiers: Object.freeze(tiers), admitted, rejected });
    },
    /**
     * @description 生存层的读数上限。
     * @returns tickLimit − R。
     */
    hardEnd: () => hardEnd,
    /**
     * @description 最近一次 settle 的摘要。
     * @returns 摘要。
     */
    summary: () => summary,
  };
};
