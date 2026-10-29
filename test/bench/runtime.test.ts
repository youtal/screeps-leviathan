/**
 * 文件摘要：bench 计量运行时（test/bench/runtime.ts）的单元测试，以假时钟驱动。
 * 覆盖：预热期间批次倍增到 minBatchCpu、预热需同时满足批次数与累计耗用、预热样本不记录、样本为每次迭代的耗用与堆增量、tick 预算用尽后停止、
 * 用例依次完成、准备函数每个 global 只调用一次、工作量计数不一致时报错；另检查用例清单的名称唯一且计数确定。
 */
import { CASES } from './cases';
import { createBench, defineCase, stepBench } from './runtime';
import type { BenchClock, BenchOptions } from './runtime';

/** 假时钟：每次迭代推进固定耗用与堆增量，tick 开始时归零耗用。 */
interface FakeClock extends BenchClock {
  now: number;
  bytes: number;
}

/**
 * @description 新建假时钟。
 * @param withHeap 是否提供堆统计。
 * @returns 假时钟。
 */
const fakeClock = (withHeap = true): FakeClock => {
  const clock: FakeClock = {
    now: 0,
    bytes: 0,
    used: () => clock.now,
    heap: () => (withHeap ? clock.bytes : undefined),
  };
  return clock;
};

const OPTIONS: BenchOptions = { warmup: 3, minWarmupCpu: 0, samples: 4, minBatchCpu: 1, maxBatch: 8, tickBudget: 10 };

test('预热期间批次倍增，预热样本不记录，样本为每次迭代的耗用与堆增量', () => {
  const clock = fakeClock();
  let prepared = 0;
  const cases = [defineCase('a', () => {
    prepared += 1;
    return { cost: 0.3 };
  }, (s) => {
    clock.now += s.cost;
    clock.bytes += 16;
    return 7;
  })];
  const state = createBench();
  const iterators = new Map<number, () => number>();
  stepBench(state, cases, clock, OPTIONS, iterators);
  // 预热：批次 1（0.3 < 1，加倍）、2（0.6，加倍）、4（1.2，不再加倍）；之后以批次 4 采样 4 个。
  expect(state.done).toBe(true);
  expect(prepared).toBe(1);
  const [record] = state.records;
  expect([record.name, record.batch, record.work]).toEqual(['a', 4, 7]);
  expect(record.cpu.map((x) => Number(x.toFixed(6)))).toEqual([0.3, 0.3, 0.3, 0.3]);
  expect(record.heap).toEqual([16, 16, 16, 16]);
  expect(iterators.size).toBe(0);
});

test('tick 预算用尽后停止，下一 tick 继续；用例依次完成', () => {
  const clock = fakeClock(false);
  const cases = ['x', 'y'].map((name) => defineCase(name, () => null, () => {
    clock.now += 2;
    return 1;
  }));
  const state = createBench();
  const iterators = new Map<number, () => number>();
  let ticks = 0;
  while (!state.done && ticks < 20) {
    clock.now = 0;
    stepBench(state, cases, clock, OPTIONS, iterators);
    ticks += 1;
    // 每个批次耗用 2，预算 10：已用达到 10 后不再开始新批次。
    expect(clock.now).toBeLessThanOrEqual(10);
  }
  expect(state.done).toBe(true);
  expect(state.ticks).toBe(ticks);
  expect(state.records.map((r) => [r.name, r.batch, r.cpu.length, r.heap])).toEqual([
    ['x', 1, 4, [null, null, null, null]],
    ['y', 1, 4, [null, null, null, null]],
  ]);
  // 每个用例 3 个预热批次加 4 个样本，共 14 个批次，每 tick 5 个。
  expect(ticks).toBe(3);
});

test('预热需同时满足批次数与累计耗用', () => {
  const clock = fakeClock(false);
  const cases = [defineCase('w', () => null, () => {
    clock.now += 1;
    return 1;
  })];
  const state = createBench();
  // 每批次耗用 1，批次数下限 3 但累计耗用下限 5：前 5 个批次都是预热，之后才采样。
  const options = { ...OPTIONS, minWarmupCpu: 5, tickBudget: 7 };
  stepBench(state, cases, clock, options, new Map());
  expect([state.warm, state.records[0].cpu.length]).toEqual([5, 2]);
});

test('工作量计数不一致时报错', () => {
  const clock = fakeClock();
  let n = 0;
  const cases = [defineCase('flaky', () => null, () => {
    clock.now += 0.6;
    n += 1;
    return n;
  })];
  expect(() => stepBench(createBench(), cases, clock, OPTIONS, new Map())).toThrow('flaky 的工作量计数不确定');
});

test('用例清单：名称唯一，单次迭代的工作量计数确定', () => {
  const names = CASES.map((c) => c.name);
  expect(new Set(names).size).toBe(names.length);
  for (const c of CASES) {
    const iterate = c.prepare();
    const first = iterate();
    expect([c.name, iterate()]).toEqual([c.name, first]);
    expect(first).toBeGreaterThan(0);
  }
});
