/**
 * 文件摘要：bench 专用产物的入口，替代正常的 bot 在私服场景中运行（rollup.bench.config.mjs 打包为 dist/bench/main.js）。
 *
 * 所属位置：test/bench/，只用于基准测试，不读写 Memory、不提交任何 intent，因此 Game.cpu.getUsed() 只含被测代码与本运行时。
 * 每 tick 调用 stepBench 在预算内运行批次；运行状态保存在 globalThis.__leviathanBench，场景以控制台表达式读取并序列化
 * （test/bench/scenarios/bench.scenario.js）。迭代函数缓存保存在 globalThis.__leviathanBenchIterators：
 * 同一 global 中 main 可能重新执行（架构附录 A F21），放在全局对象上才能跨 tick 保留。
 */
import { CASES } from './cases';
import { createBench, stepBench } from './runtime';
import type { BenchClock, BenchOptions, BenchState } from './runtime';

/** 计量参数：私服用户的 CPU 上限为 100，每 tick 只用到 40，留出余量给运行时与控制台表达式。 */
const OPTIONS: BenchOptions = { warmup: 12, minWarmupCpu: 20, samples: 30, minBatchCpu: 1, maxBatch: 4096, tickBudget: 40 };

/** 绑定到 Game.cpu 的计量来源；getHeapStatistics 在私服与官服都存在，类型上为可选。 */
const CLOCK: BenchClock = {
  /**
   * @description 本 tick 已用 CPU。
   * @returns 毫秒；私服为隔离环境的 CPU 时间加本 tick intent 的固定成本（bench 不提交 intent）。
   */
  used: () => Game.cpu.getUsed(),
  /**
   * @description 当前已用堆字节数。
   * @returns used_heap_size；平台不提供堆统计时为 undefined。
   */
  heap: () => Game.cpu.getHeapStatistics?.().used_heap_size,
};

/** 保存在全局对象上的 bench 状态。 */
interface BenchGlobal {
  __leviathanBench?: BenchState;
  /** 迭代函数缓存：{ [用例下标]: 本 global 中准备好的迭代函数 }。 */
  __leviathanBenchIterators?: Map<number, () => number>;
}

/**
 * @description 游戏每 tick 调用的主循环。
 * @returns 无返回值；推进全局的 bench 状态。
 */
export const loop = (): void => {
  const g = globalThis as BenchGlobal;
  const state = (g.__leviathanBench ??= createBench());
  const iterators = (g.__leviathanBenchIterators ??= new Map());
  stepBench(state, CASES, CLOCK, OPTIONS, iterators);
};
