/**
 * 文件摘要：单元层混沌测试（架构 13.1 的 chaos、13.2 的混沌测试），以真实的入口 createEntry、kernel 与 app.boot 驱动，
 * Memory 平台替身负责持久化；M1 还没有业务模块，用三层测试模块（生存层 guard、经济层 worker、维护层 janitor）代替，
 * 每个模块每次运行把自己分区中的计数加 1。
 *
 * 扰动由固定种子的伪随机序列逐 tick 生成：
 * - global reset：丢弃入口闭包与 kernel 实例中的全部 heap 状态，下一 tick 从已提交的 Memory 重新装配；
 * - halt：本 tick 在 Game.cpu.halt() 中结束，运行结果整体作废（平台替身的 halt 选项），随后 global reset；
 * - 模块故障：guard 或 worker 连续若干 tick 抛错；
 * - 压低 CPU：一段时间内 limit 降到 2、bucket 降到 0，经济层与维护层放不下。
 *
 * 每 tick 检查的不变量：
 * - 入口 loop 不抛错；
 * - 已提交的 Memory 可以解析，项目标记的签名与 epoch 不变；每个模块分区的计数等于它在未被 halt 的 tick 中成功运行的次数，
 *   即提交既不丢失也不重复；
 * - 生存层：guard 未熔断时每 tick 都运行，压低 CPU 不影响；
 * - 保底接管：按内核设计第 6 节的规则推算——guard 在本实例内连续失败 BREAKER_THRESHOLD 次后熔断，熔断的 tick
 *   计为第一个 degraded tick，第 SAFE_MODE_TICKS 个 degraded tick 起每 tick 追加保底循环，直到实例被替换。
 *   保底循环恰好在推算的 tick 运行，既不迟到也不误触发；
 * - 覆盖：每个 tick 要么 guard 成功运行，要么保底循环运行；不满足的连续 tick 数不超过
 *   BREAKER_THRESHOLD + SAFE_MODE_TICKS − 2。熔断计数保存在 heap，global reset 后重新累计，所以计数随 reset 重新开始；
 *   halt 的 tick 相当于 CPU 硬终止，保底循环无法接管（架构 5.7），不计入覆盖。
 * 扰动结束后再 reset 一次：正常循环在新实例的第一个 tick 恢复，三层模块都运行，保底循环不再运行。
 *
 * 限制：Jest 中无法重置 src 的模块级状态，这里的 global reset 只丢弃入口与 kernel 闭包中的状态；旧实例经 dispose 丢弃，
 * 真实引擎中不会调用 dispose。真实引擎中的 reset、halt 与压低 CPU 由私服场景 chaos 覆盖。
 */
import { type BootFacts, createBoot } from '@/app/boot';
import type { ModuleDefinition } from '@/contracts/module';
import type { UnitSpec } from '@/contracts/memory';
import { BREAKER_THRESHOLD, type Kernel, type KernelHealth } from '@/kernel/lifecycle';
import { SAFE_MODE_TICKS, createEntry } from '@/main';
import { READY_MEMORY, kernelHarness } from '../kernel/lifecycle/harness';

/** 每个种子运行的扰动 tick 数。 */
const CHAOS_TICKS = 1500;
/** 扰动结束后的观察 tick 数，覆盖维护层的一个完整周期以上。 */
const RECOVER_TICKS = 20;
/** 不满足覆盖的连续 tick 数上限：熔断前的失败 tick 加上熔断后、保底接管前的 degraded tick。 */
const UNCOVERED_LIMIT = BREAKER_THRESHOLD + SAFE_MODE_TICKS - 2;
/** 种子；扰动序列只由种子决定，失败时可以按种子复现。 */
const SEEDS = [1, 2, 3, 4, 5];

/** 一个运营中的 RCL3 房间：boot 对已初始化的存储判为 NORMAL。 */
const WORLD: BootFacts = {
  time: 0, spawns: [{ id: 's0', room: 'W1N1' }], structCount: 6, nonCoreCount: 4, sites: 0, creepCount: 4, pcHere: 0,
  controllers: [{ room: 'W1N1', level: 3, progress: 100, safeMode: undefined }],
};

/** 测试模块分区的声明；跨实例共用同一对象，满足 Memory 对 spec 身份的要求。 */
const COUNTER: UnitSpec<{ n: number }> = {
  version: 1,
  /**
   * @description 初始计数。
   * @returns 计数为 0 的数据。
   */
  initialize: () => ({ n: 0 }),
  /**
   * @description 只有版本 1。
   * @returns 计数为 0 的数据。
   */
  migrate: () => ({ n: 0 }),
};

/**
 * @description 生成 [0, 1) 均匀分布的伪随机数序列（mulberry32），同一种子得到同一序列。
 * @param seed 种子。
 * @returns 每次调用返回下一个随机数的函数。
 */
const random = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * @description 以一个种子运行混沌序列并逐 tick 检查不变量。
 * @param seed 种子。
 * @returns 本次运行的统计：保底运行的 tick 数、worker 因 CPU 不足未运行的 tick 数、reset 与 halt 次数、最长未覆盖 tick 数。
 * @throws {Error} 任一不变量不成立，消息带种子与 tick。
 */
const runChaos = (seed: number) => {
  const rand = random(seed);
  // 本 tick 的扰动与观测；cpu 是假 CPU 读数，模块运行时累加自身的耗用。
  const state = { t: 0, cpu: 0, limit: 20, bucket: 10000 };
  // 各模块剩余的故障 tick 数：{ [模块 id]: 剩余 tick 数 }。
  const faults = new Map<string, number>();
  // 本 tick 成功运行的模块 id。
  const ran = new Set<string>();
  const memory = READY_MEMORY.replace('"spawnIds":[]', '"spawnIds":["s0"]');

  /**
   * @description 构造测试模块：act 阶段累加 CPU 读数，处于故障期时抛错，否则把分区计数加 1。
   * @param id 模块 id。
   * @param tier 层级。
   * @param cost 每次运行的假 CPU 耗用。
   * @returns 模块定义。
   */
  const module = (id: string, tier: ModuleDefinition['tier'], cost: number): ModuleDefinition => ({
    id, tier, priority: 0,
    setup: (ctx) => {
      const part = ctx.memory.partition('state', COUNTER);
      return {
        act: () => {
          state.cpu += cost;
          if ((faults.get(id) ?? 0) > 0) throw new Error(`混沌：${id} 故障`);
          part.set(['n'], (part.get(['n']) as number) + 1);
          ran.add(id);
        },
      };
    },
  });
  const modules = [module('guard', 'survival', 0.5), module('worker', 'economy', 3), module('janitor', 'maintenance', 1)];
  const boot = createBoot({
    identity: { namespace: 'leviathan', schema: 1 }, release: 'chaos',
    settings: { autoClear: true, dryRun: false },
    /**
     * @description 当前 tick。
     * @returns 混沌序列的 tick。
     */
    time: () => state.t,
    /**
     * @description 世界事实不随扰动变化。
     * @returns 当前 tick 的事实。
     */
    facts: () => ({ ...WORLD, time: state.t }),
    /**
     * @description 廉价不变量。
     * @returns 固定的计数。
     */
    counts: () => ({ spawns: 1, structures: WORLD.structCount, creeps: WORLD.creepCount }),
    /**
     * @description 通知在混沌测试中丢弃。
     * @returns 无返回值。
     */
    notify: () => undefined,
  });
  const h = kernelHarness({ modules, memory, boot, game: {
    /**
     * @description 当前 tick。
     * @returns 混沌序列的 tick。
     */
    time: () => state.t,
    /**
     * @description 假 CPU 读数。
     * @returns 本 tick 已累加的耗用。
     */
    cpuUsed: () => state.cpu,
    /**
     * @description 每 tick 的 CPU 额度，压低 CPU 时为 2。
     * @returns 额度。
     */
    limit: () => state.limit,
    /**
     * @description 本 tick 的 CPU 上限：额度加 bucket，最多 500。
     * @returns 上限。
     */
    tickLimit: () => Math.min(500, state.limit + state.bucket),
    /**
     * @description bucket，压低 CPU 时为 0。
     * @returns bucket。
     */
    bucket: () => state.bucket,
  } });

  // 本 tick 的入口观测：保底循环是否运行、kernel 的健康状态、入口报告。
  const seen = { fallback: false, health: undefined as KernelHealth | undefined, reports: [] as string[] };
  let assembled = 0;
  /**
   * @description 创建一个新的入口（对应一次 global reset 后的新 global）；第二次起的装配经宿主重建 kernel。
   * @returns 入口 loop。
   */
  const newEntry = () => createEntry({
    /**
     * @description kernel 的 Memory 实例自行接管，入口不需要额外动作。
     * @returns 无返回值。
     */
    takeover: () => undefined,
    /**
     * @description 装配：返回宿主的 kernel，tick 结果记入观测。
     * @returns kernel。
     */
    assemble: (): Kernel => {
      assembled += 1;
      if (assembled > 1) h.rebuild();
      const kernel = h.kernel;
      return Object.create(kernel, { tick: { value: () => (seen.health = kernel.tick()) } }) as Kernel;
    },
    /**
     * @description 记录保底循环运行。
     * @returns 无返回值。
     */
    fallback: () => { seen.fallback = true; },
    /**
     * @description 当前 tick。
     * @returns 混沌序列的 tick。
     */
    time: () => state.t,
    /**
     * @description 保底接管通知在混沌测试中丢弃。
     * @returns 无返回值。
     */
    notify: () => undefined,
    /**
     * @description 记录入口报告。
     * @param message 说明。
     * @returns 无返回值。
     */
    report: (message) => { seen.reports.push(message); },
  });

  let loop = newEntry();
  // 按设计规则推算的状态：guard 在本实例内的连续失败次数、熔断的 tick（未熔断为 undefined）。
  let guardFails = 0;
  let trippedAt: number | undefined;
  // 各模块已提交的成功运行次数：{ [模块 id]: 次数 }。
  const committed = new Map<string, number>(modules.map((m) => [m.id, 0]));
  const stats = { fallback: 0, starved: 0, resets: 0, halts: 0, maxUncovered: 0 };
  let uncovered = 0;

  /**
   * @description 模拟 global reset：新的入口闭包与 kernel，推算状态随 heap 一同清零。
   * @param kind 来源：随机扰动、halt 之后的重建、扰动结束后的固定 reset；只有随机扰动计入 stats.resets（审计 DV-08）。
   * @returns 无返回值。
   */
  const reset = (kind: 'random' | 'halt' | 'final') => {
    loop = newEntry(); guardFails = 0; trippedAt = undefined; uncovered = 0;
    if (kind === 'random') stats.resets += 1;
  };

  /**
   * @description 推进一个 tick 并检查不变量。
   * @param halt 本 tick 是否在 halt 中结束。
   * @returns 无返回值。
   * @throws {Error} 任一不变量不成立。
   */
  const step = (halt: boolean) => {
    state.t += 1;
    state.cpu = 0;
    ran.clear();
    seen.fallback = false;
    seen.health = undefined;
    const guardFaulted = (faults.get('guard') ?? 0) > 0;
    const where = `种子 ${seed}，tick ${state.t}`;
    const { error } = h.platform.tick(() => loop(), { halt });
    expect({ where, error }).toEqual({ where, error: undefined });

    // 生存层与保底接管：先按本 tick 的结果推进推算状态，再与入口的实际行为比对。
    if (trippedAt === undefined) {
      if (guardFaulted) {
        guardFails += 1;
        if (guardFails >= BREAKER_THRESHOLD) trippedAt = state.t;
      } else {
        guardFails = 0;
      }
      expect({ where, guard: ran.has('guard') }).toEqual({ where, guard: !guardFaulted });
    } else {
      expect({ where, guard: ran.has('guard') }).toEqual({ where, guard: false });
    }
    const fallbackDue = trippedAt !== undefined && state.t - trippedAt >= SAFE_MODE_TICKS - 1;
    expect({ where, fallback: seen.fallback }).toEqual({ where, fallback: fallbackDue });
    if (seen.fallback) stats.fallback += 1;
    // 因 CPU 不足未运行：CPU 被压低、worker 未熔断且本 tick 结算后连续落选次数大于 0（预算落选或被刹车），
    // 而不是因为已熔断而不运行（审计 DV-08）。
    const worker = h.kernel.ops.status().modules.find((m) => m.id === 'worker');
    if (state.limit < 20 && !ran.has('worker') && worker?.state === 'running' && worker.starve > 0) stats.starved += 1;

    for (const [id, left] of faults) faults.set(id, Math.max(0, left - 1));
    if (halt) {
      // 本 tick 的结果整体作废：已提交的计数不变，随后进入新的 global。
      stats.halts += 1;
      reset('halt');
    } else {
      for (const id of ran) committed.set(id, committed.get(id)! + 1);
      uncovered = ran.has('guard') || seen.fallback ? 0 : uncovered + 1;
      stats.maxUncovered = Math.max(stats.maxUncovered, uncovered);
      expect({ where, uncovered: uncovered <= UNCOVERED_LIMIT }).toEqual({ where, uncovered: true });
    }

    // 持久化：Memory 可解析，项目标记完好，计数与成功运行次数一致。
    const saved = JSON.parse(h.platform.memory);
    expect({ where, sig: saved.leviathan.sys.sig, epoch: saved.leviathan.sys.epoch }).toEqual({ where, sig: 'leviathan', epoch: 0 });
    for (const [id, n] of committed) {
      expect({ where, id, n: saved.leviathan.part[id]?.state.data.n ?? 0 }).toEqual({ where, id, n });
    }
  };

  for (let i = 0; i < CHAOS_TICKS; i += 1) {
    if ((faults.get('guard') ?? 0) === 0 && rand() < 0.02) faults.set('guard', 1 + Math.floor(rand() * 6));
    if ((faults.get('worker') ?? 0) === 0 && rand() < 0.03) faults.set('worker', 1 + Math.floor(rand() * 6));
    if (state.limit === 20 && rand() < 0.01) { state.limit = 2; state.bucket = 0; }
    else if (state.limit < 20 && rand() < 0.03) { state.limit = 20; state.bucket = 10000; }
    if (rand() < 0.01) reset('random');
    step(rand() < 0.005);
  }

  // 扰动结束：清除故障与 CPU 限制，再 reset 一次，正常循环应从新实例的第一个 tick 起恢复。
  faults.clear();
  state.limit = 20;
  state.bucket = 10000;
  reset('final');
  const recovered = new Set<string>();
  for (let i = 0; i < RECOVER_TICKS; i += 1) {
    step(false);
    expect({ seed, health: seen.health, fallback: seen.fallback }).toEqual({ seed, health: 'ok', fallback: false });
    expect(ran.has('guard') && ran.has('worker')).toBe(true);
    for (const id of ran) recovered.add(id);
  }
  expect([...recovered].sort()).toEqual(['guard', 'janitor', 'worker']);
  expect(seen.reports.filter((m) => m.includes('正常循环抛错'))).toEqual([]);
  return stats;
};

test.each(SEEDS)('种子 %i：reset、halt、模块故障与压低 CPU 的扰动下，提交不丢失、生存层不被饿死、保底循环按规则接管', (seed) => {
  const stats = runChaos(seed);
  expect(stats.maxUncovered).toBeLessThanOrEqual(UNCOVERED_LIMIT);
});

test('扰动序列确实触发了保底接管、经济层因 CPU 不足未运行（未熔断且落选）、随机 reset 与 halt', () => {
  const all = SEEDS.map(runChaos);
  const sum = (key: keyof ReturnType<typeof runChaos>) => all.reduce((n, s) => n + s[key], 0);
  expect(sum('fallback')).toBeGreaterThan(0);
  expect(sum('starved')).toBeGreaterThan(0);
  expect(sum('resets')).toBeGreaterThan(0);
  expect(sum('halts')).toBeGreaterThan(0);
});
