/**
 * 文件摘要：入口切换逻辑（src/main.ts 的 createEntry）的单元测试，以假依赖驱动，不需要 Game。
 * 覆盖：正常运行只装配一次、抛错（含装配抛错）当 tick 转保底并在下一 tick 重新装配、连续 3 次抛错进入
 * 100 tick 冷却、连续 3 个 degraded tick 追加保底并在恢复后停止、接管失败与保底抛错只报告。
 */
import type { Kernel, KernelHealth } from '@/kernel/lifecycle';
import { KERNEL_COOLDOWN, KERNEL_CRASH_LIMIT, SAFE_MODE_TICKS, createEntry } from '@/main';

/**
 * @description 创建可编排的入口：每次 kernel.tick 依次取 script 中的结果（'throw' 表示抛错）。
 * @param script kernel.tick 的结果序列；用尽后保持 'ok'。
 * @param options 可选项。
 * @param options.takeoverFails 接管是否抛错。
 * @param options.fallbackFails 保底循环是否抛错。
 * @param options.assembleFails 装配是否抛错。
 * @returns 入口 loop 与观测数据。
 */
const setup = (script: (KernelHealth | 'throw')[], options: { takeoverFails?: boolean; fallbackFails?: boolean; assembleFails?: boolean } = {}) => {
  let time = 0;
  const seen = { assembled: 0, ticks: 0, disposed: 0, fallbacks: [] as number[], reports: [] as string[] };
  const loop = createEntry({
    takeover: () => { if (options.takeoverFails) throw new Error('late'); },
    assemble: (): Kernel => {
      if (options.assembleFails) throw new Error('装配失败');
      seen.assembled += 1;
      return {
        tick: () => { seen.ticks += 1; const next = script.shift() ?? 'ok'; if (next === 'throw') throw new Error('kernel 崩溃'); return next; },
        dispose: () => { seen.disposed += 1; },
      };
    },
    fallback: () => { seen.fallbacks.push(time); if (options.fallbackFails) throw new Error('保底失败'); },
    time: () => time,
    report: (message) => { seen.reports.push(message); },
  });
  /**
   * @description 推进 n 个 tick。
   * @param n tick 数，默认 1。
   * @returns 无返回值。
   */
  const run = (n = 1) => { for (let i = 0; i < n; i += 1) { time += 1; loop(); } };
  return { run, seen };
};

test('正常运行只装配一次，不运行保底循环', () => {
  const { run, seen } = setup([]);
  run(5);
  expect([seen.assembled, seen.ticks, seen.fallbacks]).toEqual([1, 5, []]);
});

test('kernel 抛错时当 tick 转保底并清理实例，下一 tick 重新装配', () => {
  const { run, seen } = setup(['ok', 'throw', 'ok']);
  run(3);
  expect(seen.fallbacks).toEqual([2]);
  expect([seen.assembled, seen.disposed]).toEqual([2, 1]);
  expect(seen.reports[0]).toContain('正常循环抛错');
});

test(`连续 ${KERNEL_CRASH_LIMIT} 次抛错后停用 ${KERNEL_COOLDOWN} tick，只运行保底；冷却结束后重新装配`, () => {
  const { run, seen } = setup(['throw', 'throw', 'throw']);
  run(3);
  expect(seen.assembled).toBe(3);
  run(KERNEL_COOLDOWN);
  expect(seen.assembled).toBe(3);
  expect(seen.fallbacks).toHaveLength(3 + KERNEL_COOLDOWN);
  run(1);
  expect(seen.assembled).toBe(4);
  expect(seen.reports.some((r) => r.includes('停用'))).toBe(true);
});

test('装配抛错按 kernel 抛错计数', () => {
  const { run, seen } = setup([], { assembleFails: true });
  run(KERNEL_CRASH_LIMIT);
  expect(seen.fallbacks).toHaveLength(KERNEL_CRASH_LIMIT);
  expect(seen.reports.some((r) => r.includes('停用'))).toBe(true);
});

test(`连续 ${SAFE_MODE_TICKS} 个 degraded tick 后追加保底，恢复后停止`, () => {
  const { run, seen } = setup(['degraded', 'degraded', 'degraded', 'degraded', 'ok', 'degraded']);
  run(6);
  expect(seen.fallbacks).toEqual([3, 4]);
  expect(seen.ticks).toBe(6);
});

test('接管失败与保底循环抛错只报告，不中断入口', () => {
  const { run, seen } = setup(['throw'], { takeoverFails: true, fallbackFails: true });
  expect(() => run(2)).not.toThrow();
  expect(seen.reports.filter((r) => r.includes('Memory 接管失败'))).toHaveLength(2);
  expect(seen.reports.some((r) => r.includes('保底循环抛错'))).toBe(true);
  expect(seen.ticks).toBe(2);
});
