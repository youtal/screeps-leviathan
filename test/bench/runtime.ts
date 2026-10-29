/**
 * 文件摘要：bench 在游戏沙箱内的计量运行时：按 tick 预算分批运行基准用例，记录每次迭代的 CPU、堆增量与工作量计数。
 *
 * 所属位置：test/bench/，只打进 bench 专用产物（rollup.bench.config.mjs），不进入游戏构建产物。
 * 计量口径：CPU 取 Game.cpu.getUsed()，私服 driver 以隔离环境的 isolate.cpuTime 计时（driver lib/runtime/runtime.js），
 * 与官服的计量方式相同；堆增量取 Game.cpu.getHeapStatistics() 的 used_heap_size 差值，受 GC 影响，只作分配量的近似；
 * 工作量计数由用例返回，与机器无关，用作确定性的回归指标。三者的取舍见 docs/proposal/2026-10-22-bench.md。
 * 流程：每个用例先预热，批次内迭代次数从 1 起倍增，直到一个批次的耗用不少于 minBatchCpu；预热至少 warmup 个批次，
 * 且累计耗用不少于 minWarmupCpu，使 JIT 在采样前完成优化（只按批次数预热时，快的用例几毫秒就开始采样，中位数随 JIT 波动）。
 * 预热结束后以该批次大小采样，每个样本为"批次耗用 ÷ 迭代次数"；采满后进入下一个用例。
 * 状态：BenchState 是普通数据，由入口保存在 globalThis 上并序列化给场景读取；本文件没有模块级可变状态。
 */

/** 一个基准用例：prepare 在计时之外准备输入，返回单次迭代函数；迭代函数返回确定的工作量计数。 */
export interface BenchCase {
  readonly name: string;
  prepare(): () => number;
}

/** 计量来源，由入口绑定到 Game.cpu，单元测试可注入假时钟。 */
export interface BenchClock {
  /** 本 tick 已用 CPU（毫秒）。 */
  used(): number;
  /** 当前已用堆字节数；平台不提供时为 undefined。 */
  heap(): number | undefined;
}

/** 计量参数。 */
export interface BenchOptions {
  /** 每个用例的最少预热批次数，预热样本不记录。 */
  readonly warmup: number;
  /** 每个用例预热的最少累计耗用（毫秒）。 */
  readonly minWarmupCpu: number;
  /** 每个用例记录的样本数。 */
  readonly samples: number;
  /** 批次耗用的下限（毫秒）：预热期间批次小于它时迭代次数加倍，减小计时分辨率的影响。 */
  readonly minBatchCpu: number;
  /** 批次迭代次数的上限。 */
  readonly maxBatch: number;
  /** 每 tick 运行批次的 CPU 上限：已用 CPU 达到它后本 tick 不再开始新批次。 */
  readonly tickBudget: number;
}

/** 一个用例的记录。 */
export interface CaseRecord {
  readonly name: string;
  /** 采样时的批次迭代次数。 */
  batch: number;
  /** 每次迭代的 CPU（毫秒），每个批次一个样本。 */
  readonly cpu: number[];
  /** 每次迭代的堆增量（字节）；平台不提供堆统计时为 null。 */
  readonly heap: (number | null)[];
  /** 工作量计数；尚未运行时为 −1。 */
  work: number;
}

/** 运行状态：全部字段可 JSON 序列化，供场景读取；迭代函数另存在入口持有的缓存中。 */
export interface BenchState {
  /** 当前用例的下标。 */
  index: number;
  /** 已完成的预热批次数。 */
  warm: number;
  /** 当前用例预热的累计耗用（毫秒）。 */
  warmSpent: number;
  /** 当前批次的迭代次数。 */
  batch: number;
  /** 全部用例采样完成。 */
  done: boolean;
  /** 已运行的 tick 数。 */
  ticks: number;
  readonly records: CaseRecord[];
}

/**
 * @description 定义用例：输入类型由 setup 推断，保存在闭包中，用例列表因此不需要按输入类型区分。
 * @template S 用例输入的类型。
 * @param name 用例名，形如 `模块.函数/变体`，作为基准文件中的键。
 * @param setup 准备输入，在计时之外调用一次。
 * @param run 单次迭代，返回工作量计数；同一输入下每次迭代的计数必须相同。
 * @returns 用例。
 */
export const defineCase = <S>(name: string, setup: () => S, run: (state: S) => number): BenchCase => ({
  name,
  prepare: () => {
    const state = setup();
    return () => run(state);
  },
});

/**
 * @description 新建运行状态。
 * @returns 初始状态，从第一个用例开始。
 */
export const createBench = (): BenchState => ({ index: 0, warm: 0, warmSpent: 0, batch: 1, done: false, ticks: 0, records: [] });

/**
 * @description 在本 tick 的预算内运行批次。迭代函数只在本 global 中有效，global reset 后由 prepare 重建；
 * 已记录的样本随状态保留在 globalThis 上，reset 时一并丢失，场景以 done 判断是否完成。
 * @param state 运行状态，原地更新。
 * @param cases 用例列表，顺序与记录一致。
 * @param clock 计量来源。
 * @param options 计量参数。
 * @param iterators 本 global 中已准备的迭代函数缓存：{ [用例下标]: 迭代函数 }，由入口持有。
 * @returns 无返回值；修改 state 与 iterators。
 * @throws {Error} 同一用例的工作量计数前后不一致（用例不确定，结果不可比）。
 */
export const stepBench = (
  state: BenchState,
  cases: readonly BenchCase[],
  clock: BenchClock,
  options: BenchOptions,
  iterators: Map<number, () => number>,
): void => {
  state.ticks += 1;
  while (!state.done && clock.used() < options.tickBudget) {
    const index = state.index;
    const spec = cases[index];
    let iterate = iterators.get(index);
    if (iterate === undefined) {
      iterate = spec.prepare();
      iterators.set(index, iterate);
    }
    let record = state.records[index];
    if (record === undefined) {
      record = { name: spec.name, batch: state.batch, cpu: [], heap: [], work: -1 };
      state.records.push(record);
    }
    const batch = state.batch;
    const heap0 = clock.heap();
    const t0 = clock.used();
    let work = iterate();
    for (let k = 1; k < batch; k += 1) {
      if (iterate() !== work) work = Number.NaN;
    }
    const spent = clock.used() - t0;
    const heap1 = clock.heap();
    if (Number.isNaN(work) || (record.work >= 0 && record.work !== work)) throw new Error(`用例 ${spec.name} 的工作量计数不确定`);
    record.work = work;
    if (state.warm < options.warmup || state.warmSpent < options.minWarmupCpu) {
      state.warm += 1;
      state.warmSpent += spent;
      if (spent < options.minBatchCpu && batch < options.maxBatch) state.batch = Math.min(batch * 2, options.maxBatch);
      continue;
    }
    record.batch = batch;
    record.cpu.push(spent / batch);
    record.heap.push(heap0 === undefined || heap1 === undefined ? null : (heap1 - heap0) / batch);
    if (record.cpu.length >= options.samples) {
      iterators.delete(index);
      state.index += 1;
      state.warm = 0;
      state.warmSpent = 0;
      state.batch = 1;
      state.done = state.index >= cases.length;
    }
  }
};
