/**
 * 文件摘要：入口切换逻辑（src/main.ts 的 createEntry）的单元测试，以假依赖驱动，不需要 Game。
 * 覆盖：正常运行只装配一次、抛错（含装配抛错）当 tick 转保底并在下一 tick 重新装配、连续 3 次抛错进入
 * 100 tick 冷却、连续 3 个 degraded tick 追加保底并在恢复后停止、接管失败与保底抛错只报告、
 * 软重置后重新装配且不计入抛错、暂停 tick 不改变 degraded 计数且连续暂停超过上限后按 degraded 计数、
 * 保底接管开始时通知且间隔内不重复（审计 LC-07）、入口状态（审计 LC-04）。
 */
import type { EntryStatus } from '@/app/ops';
import type { Kernel, KernelHealth } from '@/kernel/lifecycle';
import {
  ENTRY_KEY, type EntryLoop, FALLBACK_NOTIFY_GAP, KERNEL_COOLDOWN, KERNEL_CRASH_LIMIT, PAUSE_LIMIT, SAFE_MODE_TICKS, createEntry, resolveEntry,
} from '@/main';

/**
 * @description 创建可编排的入口：每次 kernel.tick 依次取 script 中的结果（'throw' 表示抛错，'reset' 表示登记软重置的暂停 tick）。
 * @param script kernel.tick 的结果序列；用尽后保持 'ok'。
 * @param options 可选项。
 * @param options.takeoverFails 接管是否抛错。
 * @param options.fallbackFails 保底循环是否抛错。
 * @param options.assembleFails 装配是否抛错。
 * @param options.thrown 'throw' 时 kernel 抛出的值，默认为 Error('kernel 崩溃')。
 * @returns 入口 loop 与观测数据。
 */
const setup = (script: (KernelHealth | 'throw' | 'reset')[],
  options: { takeoverFails?: boolean; fallbackFails?: boolean; assembleFails?: boolean; thrown?: unknown } = {}) => {
  let time = 0;
  const seen = { assembled: 0, ticks: 0, disposed: 0, fallbacks: [] as number[], reports: [] as string[], notices: [] as string[],
    infos: [] as string[], entry: undefined as (() => EntryStatus) | undefined };
  const loop = createEntry({
    takeover: () => { if (options.takeoverFails) throw new Error('late'); },
    assemble: (entryStatus): Kernel => {
      seen.entry = entryStatus;
      if (options.assembleFails) throw new Error('装配失败');
      seen.assembled += 1;
      let reset = false;
      return {
        tick: () => {
          seen.ticks += 1;
          const next = script.shift() ?? 'ok';
          if (next === 'throw') throw 'thrown' in options ? options.thrown : new Error('kernel 崩溃');
          if (next === 'reset') { reset = true; return 'paused'; }
          return next;
        },
        resetRequested: () => reset,
        dispose: () => { seen.disposed += 1; },
        ops: undefined as never,
        console: undefined as never,
      };
    },
    fallback: () => { seen.fallbacks.push(time); if (options.fallbackFails) throw new Error('保底失败'); },
    notify: (message) => { seen.notices.push(message); },
    time: () => time,
    report: (message) => { seen.reports.push(message); },
    notice: (message) => { seen.infos.push(message); },
  });
  /**
   * @description 推进 n 个 tick。
   * @param n tick 数，默认 1。
   * @returns 无返回值。
   */
  const run = (n = 1) => { for (let i = 0; i < n; i += 1) { time += 1; loop(); } };
  return { run, seen, loop };
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

test('软重置：本 tick 正常结束后销毁实例，下一 tick 重新装配，不计入抛错', () => {
  const { run, seen } = setup(['ok', 'reset', 'ok', 'reset', 'reset', 'reset']);
  run(6);
  expect([seen.assembled, seen.disposed, seen.fallbacks, seen.reports]).toEqual([4, 4, [], []]);
});

test('暂停 tick 不改变 degraded 计数，也不运行保底', () => {
  const { run, seen } = setup(['degraded', 'degraded', 'paused', 'paused', 'degraded', 'paused', 'ok', 'degraded']);
  run(8);
  expect(seen.fallbacks).toEqual([5]);
});

test(`连续暂停超过 ${PAUSE_LIMIT} 个 tick 后按 degraded 计数，跨软重置累计`, () => {
  const script: ('paused' | 'reset')[] = [];
  for (let i = 0; i < PAUSE_LIMIT + SAFE_MODE_TICKS; i += 1) script.push(i % 2 === 0 ? 'reset' : 'paused');
  const { run, seen } = setup(script);
  run(PAUSE_LIMIT + SAFE_MODE_TICKS - 1);
  expect(seen.fallbacks).toEqual([]);
  run(1);
  expect(seen.fallbacks).toEqual([PAUSE_LIMIT + SAFE_MODE_TICKS]);
  run(1); // 恢复 ok 后清零
  expect(seen.fallbacks).toEqual([PAUSE_LIMIT + SAFE_MODE_TICKS]);
});

test(`SB-01：超过 ${PAUSE_LIMIT} 个暂停 tick 后仍每 tick 软重置，按失败计数并进入冷却，重建次数有上限`, () => {
  const { run, seen } = setup(Array.from({ length: 300 }, () => 'reset' as const));
  run(PAUSE_LIMIT);
  expect(seen.reports).toEqual([]); // 上限内的软重置不计失败
  run(300 - PAUSE_LIMIT);
  // 前 PAUSE_LIMIT 个 tick 各装配一次；之后每轮 KERNEL_CRASH_LIMIT 次重建触发一次 KERNEL_COOLDOWN 冷却。
  const rounds = Math.ceil((300 - PAUSE_LIMIT) / (KERNEL_CRASH_LIMIT + KERNEL_COOLDOWN));
  expect(seen.assembled).toBe(PAUSE_LIMIT + rounds * KERNEL_CRASH_LIMIT);
  expect(seen.reports.filter((r) => r.includes('停用'))).toHaveLength(rounds);
});

test('SB-01：超限后软重置与普通暂停交替，失败计数不清零，仍进入冷却', () => {
  const script: ('paused' | 'reset')[] = [];
  for (let i = 0; i < 40; i += 1) script.push(i % 2 === 0 ? 'reset' : 'paused');
  const { run, seen } = setup(script);
  run(40);
  expect(seen.reports.some((r) => r.includes('停用'))).toBe(true);
  expect(seen.assembled).toBe(8);
});

test('LC-07：保底接管开始时通知一次并写明原因；持续接管不重复；间隔内的再次接管不通知，超过间隔后再通知', () => {
  const { run, seen } = setup(['throw', 'throw', 'throw']);
  run(1);
  expect(seen.notices).toEqual(['tick 1：保底循环接管（正常循环抛错）']);
  run(2 + KERNEL_COOLDOWN); // 继续抛错并进入冷却：保底一直在运行，不再通知
  expect(seen.notices).toHaveLength(1);
  run(1); // 冷却结束，重新装配后恢复 ok
  expect(seen.fallbacks.at(-1)).toBeLessThan(KERNEL_COOLDOWN + 4);
  const late = setup([...Array.from({ length: FALLBACK_NOTIFY_GAP }, () => 'ok' as const), 'degraded', 'degraded', 'degraded']);
  late.run(FALLBACK_NOTIFY_GAP + SAFE_MODE_TICKS);
  expect(late.seen.notices).toEqual([`tick ${FALLBACK_NOTIFY_GAP + SAFE_MODE_TICKS}：保底循环接管（连续 degraded）`]);
});

test('LC-07：两次接管间隔不足 FALLBACK_NOTIFY_GAP 时只通知一次；通知失败只报告', () => {
  const { run, seen } = setup(['throw', 'ok', 'throw']);
  run(3);
  expect(seen.fallbacks).toEqual([1, 3]);
  expect(seen.notices).toHaveLength(1);
  let time = 0;
  const reports: string[] = [];
  const loop = createEntry({
    takeover: () => undefined,
    assemble: () => { throw new Error('装配失败'); },
    fallback: () => undefined,
    notify: () => { throw new Error('平台拒绝'); },
    time: () => time,
    report: (message) => { reports.push(message); },
    notice: () => undefined,
  });
  time = 1;
  loop();
  expect(reports).toContain('保底接管通知发送失败');
});

test('LC-04：入口状态包含连续失败、冷却剩余与最近一次失败', () => {
  const { run, seen } = setup(['ok', 'throw', 'throw', 'throw']);
  run(1);
  expect(seen.entry!()).toEqual({ time: 1, cooldown: 0, crashes: 0, degraded: 0, paused: 0, lastFailure: undefined });
  run(2);
  expect(seen.entry!()).toMatchObject({ time: 3, crashes: 2, lastFailure: { tick: 3, message: '正常循环抛错：kernel 崩溃' } });
  run(1); // 第 3 次失败进入冷却
  expect(seen.entry!()).toMatchObject({ time: 4, cooldown: KERNEL_COOLDOWN + 1, crashes: 0 });
  run(10);
  expect(seen.entry!().cooldown).toBe(KERNEL_COOLDOWN + 1 - 10);
});

test('ultrareview 第 6 项：kernel 抛出无法转为文本的值时，入口不抛错，照常清理实例、计数并当 tick 转保底', () => {
  const unreadable = new Error('e');
  Object.defineProperty(unreadable, 'message', { get: () => { throw new Error('message 读取失败'); } });
  const values: unknown[] = [Object.create(null), { toString: () => { throw new Error('toString 失败'); } }, unreadable];
  for (const thrown of values) {
    const { run, seen } = setup(['throw'], { thrown });
    expect(() => run(1)).not.toThrow();
    expect(seen.fallbacks).toEqual([1]);
    expect(seen.disposed).toBe(1);
    expect(seen.entry!()).toMatchObject({ crashes: 1, lastFailure: { tick: 1, message: '正常循环抛错：（无法转为文本的抛出值）' } });
    run(1);
    expect(seen.assembled).toBe(2);
  }
});

describe('模块重新执行（内核设计第 6 节）', () => {
  /**
   * @description 构造只记录调用的入口替身。
   * @param log 调用记录。
   * @param name 入口名。
   * @returns 入口。
   */
  const fake = (log: string[], name: string): EntryLoop => Object.assign(() => { log.push(`${name}.loop`); }, {
    reevaluated: () => { log.push(`${name}.reevaluated`); },
    dispose: () => { log.push(`${name}.dispose`); },
  });

  test('同一 global 中同一构建的重新执行沿用已登记的入口；构建不同时销毁旧入口再新建；登记不可枚举', () => {
    const target = {};
    const log: string[] = [];
    let created = 0;
    const create = (name: string) => () => { created += 1; return fake(log, name); };
    const first = resolveEntry(target, 'b1', create('a'));
    expect(resolveEntry(target, 'b1', create('x'))).toBe(first);
    expect(created).toBe(1);
    const next = resolveEntry(target, 'b2', create('b'));
    expect(next).not.toBe(first);
    expect(log).toEqual(['a.reevaluated', 'a.dispose']);
    expect(Object.keys(target)).toEqual([]);
    expect((target as Record<symbol, unknown>)[ENTRY_KEY]).toMatchObject({ build: 'b2' });
  });

  test('注册表中的值不完整时当作没有，直接新建', () => {
    const target = { [ENTRY_KEY]: { build: 'b1' } };
    const log: string[] = [];
    resolveEntry(target, 'b1', () => fake(log, 'a'));
    expect((target as Record<symbol, { build: string }>)[ENTRY_KEY].build).toBe('b1');
    expect(log).toEqual([]);
  });

  test('沿用入口时 kernel 不重新装配；重新执行的次数在 1、10、100 次时各记录一条 info', () => {
    const { run, seen, loop } = setup([]);
    run(1);
    for (let i = 0; i < 120; i += 1) { loop.reevaluated(); run(1); }
    expect(seen.assembled).toBe(1);
    expect(seen.infos.map((m) => /累计 (\d+) 次/.exec(m)?.[1])).toEqual(['1', '10', '100']);
  });

  test('dispose 销毁 kernel，之后 loop 不再运行', () => {
    const { run, seen, loop } = setup([]);
    run(2);
    loop.dispose();
    run(3);
    expect(seen.disposed).toBe(1);
    expect(seen.ticks).toBe(2);
  });
});
