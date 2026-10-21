/**
 * 文件摘要：kernel.process 的模块清单规划：校验、隔离与稳定拓扑排序（设计见 docs/design/kernel/README.md 第 3 节，
 * 契约见 src/contracts/module.ts 与 docs/design/contracts/README.md 第 2 节）。
 *
 * 所属位置：src/kernel/process/，kernel 内部模块；纯函数，不读写游戏对象与持久化存储，每个 global 启动时调用一次。
 * 隔离规则（contracts 第 2 节）：只拒绝有问题的模块及经 requires 直接或间接依赖它的模块，其余照常启动。拒绝条件：
 * id 为空、保留或重复（重复各方都拒绝）；requires/optional 指向不存在的模块；requires 了层级更低的模块；处在 requires
 * 依赖环上，或经 requires 依赖了成环的模块。排序：在 requires 与会排入的 optional 都已排好的模块中，按"层级 → priority → id"
 * 选出下一个；只由 optional 构成的环不拒绝，按同一顺序打破。
 * 成本：模块数为 n、依赖边数为 e 时为 O(n² + e)，模块数很小且每个 global 只执行一次。
 */
import type { Tier } from '@/contracts/cpu';
import type { ModuleDefinition } from '@/contracts/module';

/** { [层级]: 准入优先顺序 }，数值越小越先，生存层最先。 */
export const TIER_RANK: Readonly<Record<Tier, number>> = { survival: 0, economy: 1, maintenance: 2, planning: 3 };

/** boot 的上下文 owner 与控制台命名空间（kernel.lifecycle）。 */
export const BOOT_ID = 'boot';
/** 实体空间公共切片的 owner（kernel.memory）。 */
export const CORE_OWNER = 'core';
/** kernel 自身分区（启停标志）的 owner（kernel.lifecycle）。 */
export const KERNEL_OWNER = 'kernel';
/** app.ops 运维命令的控制台命名空间（模块 id 同时是控制台命名空间）。 */
export const OPS_NAMESPACE = 'ops';

/**
 * 保留的模块 id。四个名字的使用方都从这里导入，保留表与实际 owner 只有一个来源（审计 PA-08）；
 * 新增保留名时在上面增加常量并加入此表。
 */
export const RESERVED_MODULE_IDS: readonly string[] = [BOOT_ID, CORE_OWNER, KERNEL_OWNER, OPS_NAMESPACE];

/** 清单规划的结果。 */
export interface ModulePlan {
  /** 通过校验的模块，按执行顺序排列。 */
  readonly order: readonly ModuleDefinition[];
  /** { [被拒绝的模块 id]: 拒绝原因 }；空 id 记为 `（空 id）`。 */
  readonly rejected: ReadonlyMap<string, string>;
}

/**
 * @description 比较两个模块的执行先后：层级优先，其次 priority，最后 id。
 * @param a 模块 a。
 * @param b 模块 b。
 * @returns 负数表示 a 在前。
 */
const compare = (a: ModuleDefinition, b: ModuleDefinition): number =>
  TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * @description 校验模块清单，隔离有问题的模块，并对其余模块做稳定拓扑排序。
 * @param modules 装配方给出的全部模块定义。
 * @returns 执行顺序与被拒绝的模块及原因。
 */
export const planModules = (modules: readonly ModuleDefinition[]): ModulePlan => {
  // { [模块 id]: 拒绝原因 }。
  const rejected = new Map<string, string>();
  // { [模块 id]: 出现次数 }，用于发现重复 id。
  const counts = new Map<string, number>();
  for (const m of modules) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  // { [模块 id]: 唯一的模块定义 }，只含 id 合法且不重复的模块。
  const byId = new Map<string, ModuleDefinition>();
  for (const m of modules) {
    if (typeof m.id !== 'string' || m.id === '') rejected.set('（空 id）', 'id 为空');
    else if (RESERVED_MODULE_IDS.includes(m.id)) rejected.set(m.id, `id ${m.id} 为保留名`);
    else if (counts.get(m.id)! > 1) rejected.set(m.id, `id ${m.id} 重复`);
    else byId.set(m.id, m);
  }
  for (const m of byId.values()) {
    for (const dep of [...(m.requires ?? []), ...(m.optional ?? [])]) {
      if (!counts.has(dep)) rejected.set(m.id, `依赖的模块 ${dep} 不存在`);
    }
    for (const dep of m.requires ?? []) {
      const target = byId.get(dep);
      if (target && TIER_RANK[target.tier] > TIER_RANK[m.tier]) {
        rejected.set(m.id, `requires 了层级更低的模块 ${dep}（${m.tier} → ${target.tier}）`);
      }
    }
  }
  // 依赖传播：requires 了被拒绝或不可用（重复、保留）的模块，同样拒绝；直到不再变化。
  for (let changed = true; changed;) {
    changed = false;
    for (const m of byId.values()) {
      if (rejected.has(m.id)) continue;
      const bad = (m.requires ?? []).find((dep) => rejected.has(dep) || !byId.has(dep));
      if (bad !== undefined) { rejected.set(m.id, `依赖的模块 ${bad} 被拒绝`); changed = true; }
    }
  }
  // 依赖环只按 requires 检测：反复接纳 requires 都已接纳的模块，接纳不了的处在 requires 环上，
  // 或经 requires 依赖了成环的模块。optional 不参与检测，只依赖环成员的 optional 方不被连带拒绝。
  const candidates = [...byId.values()].filter((m) => !rejected.has(m.id));
  // 不在 requires 环上的模块 id，即最终会排入执行顺序的模块。
  const acyclic = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const m of candidates) {
      if (!acyclic.has(m.id) && (m.requires ?? []).every((dep) => acyclic.has(dep))) { acyclic.add(m.id); changed = true; }
    }
  }
  for (const m of candidates) {
    if (!acyclic.has(m.id)) rejected.set(m.id, '处在 requires 依赖环上，或经 requires 依赖了成环的模块');
  }
  // 拓扑排序：requires 必须先排好；optional 只等待最终会排入的模块。
  const remaining = candidates.filter((m) => acyclic.has(m.id));
  const placed = new Set<string>();
  const order: ModuleDefinition[] = [];
  /**
   * @description 判断模块是否处在未排入模块的等待环上：沿未排入的 requires 与 optional 依赖能否回到它自己。
   * 只在所有可排的模块都在等待 optional 时调用（即清单含 optional 环），模块数很小，逐个搜索即可。
   * @param start 待判断的模块。
   * @returns 在环上时为 true。
   */
  const onCycle = (start: ModuleDefinition): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const m = stack.pop()!;
      for (const dep of [...(m.requires ?? []), ...(m.optional ?? [])]) {
        if (dep === start.id) return true;
        if (placed.has(dep) || !acyclic.has(dep) || seen.has(dep)) continue;
        seen.add(dep);
        stack.push(byId.get(dep)!);
      }
    }
    return false;
  };
  while (order.length < remaining.length) {
    let next: ModuleDefinition | undefined;
    // requires 已排好、只在等待 optional 的模块。
    const waiting: ModuleDefinition[] = [];
    for (const m of remaining) {
      if (placed.has(m.id) || !(m.requires ?? []).every((dep) => placed.has(dep))) continue;
      if ((m.optional ?? []).every((dep) => placed.has(dep) || !acyclic.has(dep))) {
        if (next === undefined || compare(m, next) < 0) next = m;
      } else {
        waiting.push(m);
      }
    }
    // 没有可排的模块时，未排入的模块之间必有等待环：取等待图的一个汇点强连通分量，requires 在其中无环，
    // 必有成员的 requires 已全部排好，它就在 waiting 中且在环上。按"层级 → priority → id"取环上最先者打破。
    if (next === undefined) {
      for (const m of waiting) if (onCycle(m) && (next === undefined || compare(m, next) < 0)) next = m;
    }
    if (next === undefined) break;
    placed.add(next.id);
    order.push(next);
  }
  return { order, rejected };
};
