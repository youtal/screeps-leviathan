/**
 * 文件摘要：kernel.profiler（src/kernel/profiler/index.ts）的单元测试。
 * 以注入的 CPU 读数驱动，覆盖标签拼接、同 tick 累计、beginTick 结算与清零、平滑值计算与衰减、
 * 标签上限与 overflow，以及快照与内部记录隔离。
 */
import { PROFILE_ALPHA, createProfiler } from '../../../src/kernel/profiler';

/**
 * @description 创建可控 CPU 读数的 profiler。
 * @param maxLabels 标签数量上限，省略时用默认值。
 * @returns profiler 与设置 CPU 读数的函数。
 */
const setup = (maxLabels?: number) => {
  let cpu = 0;
  const profiler = createProfiler({ cpuUsed: () => cpu, maxLabels });
  return { profiler, at: (value: number) => { cpu = value; } };
};

/**
 * @description 用指定的开始与结束读数完成一次计时。
 * @param measure Measure 对象。
 * @param at 设置 CPU 读数的函数。
 * @param op 操作名。
 * @param from 开始读数。
 * @param to 结束读数。
 * @returns 无返回值。
 */
const time = (measure: ReturnType<ReturnType<typeof setup>['profiler']['scope']>, at: (v: number) => void, op: string, from: number, to: number) => {
  at(from);
  const start = measure.begin();
  at(to);
  measure.end(op, start);
};

test('标签为 <作用域>.<op>；同 tick 多次调用累计，beginTick 后成为上一 tick 的统计', () => {
  const { profiler, at } = setup();
  const m = profiler.scope('mining');
  time(m, at, 'plan', 0, 1.5);
  time(m, at, 'plan', 2, 2.5);
  expect(profiler.snapshot()).toEqual([{ label: 'mining.plan', tick: 0, calls: 0, average: 0 }]);
  profiler.beginTick();
  expect(profiler.snapshot()).toEqual([{ label: 'mining.plan', tick: 2, calls: 2, average: 2 }]);
});

test('平滑值按 PROFILE_ALPHA 更新，未调用的 tick 按 0 衰减；本 tick 累计在结算后清零', () => {
  const { profiler, at } = setup();
  const m = profiler.scope('s');
  time(m, at, 'op', 0, 4);
  profiler.beginTick();
  time(m, at, 'op', 0, 2);
  profiler.beginTick();
  const second = 4 * (1 - PROFILE_ALPHA) + 2 * PROFILE_ALPHA;
  expect(profiler.snapshot()[0]).toEqual({ label: 's.op', tick: 2, calls: 1, average: second });
  profiler.beginTick();
  expect(profiler.snapshot()[0]).toEqual({ label: 's.op', tick: 0, calls: 0, average: second * (1 - PROFILE_ALPHA) });
});

test('同一前缀的多个作用域共享标签记录', () => {
  const { profiler, at } = setup();
  time(profiler.scope('a'), at, 'x', 0, 1);
  time(profiler.scope('a'), at, 'x', 0, 1);
  profiler.beginTick();
  expect(profiler.snapshot()).toEqual([{ label: 'a.x', tick: 2, calls: 2, average: 2 }]);
});

test('超过标签上限时不创建新标签，丢弃计时并累加 overflow；已有标签照常计时', () => {
  const { profiler, at } = setup(2);
  const m = profiler.scope('s');
  time(m, at, 'a', 0, 1);
  time(m, at, 'b', 0, 1);
  time(m, at, 'c', 0, 1);
  time(m, at, 'c', 0, 1);
  time(m, at, 'a', 0, 1);
  profiler.beginTick();
  expect(profiler.snapshot().map((e) => [e.label, e.calls])).toEqual([['s.a', 2], ['s.b', 1]]);
  expect(profiler.overflow).toBe(2);
});

test('快照是新数组，修改它不影响内部记录', () => {
  const { profiler, at } = setup();
  time(profiler.scope('s'), at, 'op', 0, 1);
  profiler.beginTick();
  const snap = profiler.snapshot() as unknown as { tick: number }[];
  snap[0].tick = 999;
  snap.length = 0;
  expect(profiler.snapshot()).toEqual([{ label: 's.op', tick: 1, calls: 1, average: 1 }]);
});
