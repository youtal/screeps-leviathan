/**
 * 文件摘要：app.boot 判定核心（src/app/boot/assess.ts）的单元测试。
 * 覆盖 Memory 视图（11.3 与 SR-02 的 UNLOADABLE）、附录 C 的启动判定测试向量（M1 中 7–13 按设计第 4.3 节判为 AMBIGUOUS）、
 * 11.4 c′ 的中证据、OURS 分支保持 AMBIGUOUS，以及人工指定（boot.force）的动作。
 */
import type { ProjectMarker, RawMemorySummary } from '@/contracts/boot';
import { GAP, type MemoryView, SAFE_MODE_DURATION, assess, memoryView } from '@/app/boot/assess';
import type { BootFacts } from '@/app/boot/facts';

const NS = 'leviathan';
const SCHEMA = 1;

/**
 * @description 构造世界事实，默认没有任何资产。
 * @param o 覆盖的字段。
 * @returns 事实。
 */
const facts = (o: Partial<BootFacts> = {}): BootFacts => ({
  time: 100000, spawns: [], structCount: 0, nonCoreCount: 0, sites: 0, creepCount: 0, pcHere: 0, controllers: [], ...o,
});

/**
 * @description 构造开局世界 W：一个 spawn 与一个 RCL1 的 controller。
 * @param safeMode controller 的 safe mode 剩余 tick；undefined 表示时钟不可用。
 * @returns 事实。
 */
const opening = (safeMode: number | undefined): BootFacts => facts({
  spawns: [{ id: 's1', room: 'W1N1' }], structCount: 2,
  controllers: [{ room: 'W1N1', level: 1, progress: 0, safeMode }],
});

/**
 * @description 构造项目标记。
 * @param o 覆盖的字段。
 * @returns 项目标记。
 */
const marker = (o: Partial<ProjectMarker> = {}): ProjectMarker => ({
  sig: NS, schema: SCHEMA, shard: 'x', epoch: 1, lastRun: 99999, release: 't',
  fp: { rooms: ['W1N1'], spawnIds: ['s0'], creepCount: 5 },
  mode: { mode: 'NORMAL', strength: 'strong', since: 1, evidence: [] }, ...o,
});

/**
 * @description 构造原始 Memory 的概要。
 * @param o 覆盖的字段。
 * @returns 概要。
 */
const summary = (o: Partial<RawMemorySummary> = {}): RawMemorySummary =>
  ({ empty: false, parsed: true, rootKeys: [], marker: null, ...o });

/**
 * @description 由概要与当前标记得出 Memory 视图。
 * @param s 概要。
 * @param current 当前可读的项目标记。
 * @returns Memory 视图。
 */
const view = (s: RawMemorySummary, current: ProjectMarker | null = null): MemoryView =>
  memoryView({ summary: s, current, namespace: NS, schema: SCHEMA });

const EMPTY = view(summary({ empty: true }));
const FOREIGN = view(summary({ rootKeys: ['other'] }));
const CORRUPT = view(summary({ parsed: false }));
const ours = (m: ProjectMarker = marker()) => view(summary({ rootKeys: [NS], marker: m }), m);

describe('Memory 视图', () => {
  test('11.3 的五种状态；当前可读即为 OURS（含本实例刚初始化的情形）', () => {
    expect(EMPTY).toMatchObject({ state: 'EMPTY', initializable: true });
    expect(CORRUPT).toMatchObject({ state: 'CORRUPT', initializable: false });
    expect(FOREIGN).toMatchObject({ state: 'FOREIGN', initializable: true });
    expect(view(summary({ rootKeys: [NS] }))).toMatchObject({ state: 'FOREIGN', initializable: false });
    expect(view(summary({ rootKeys: [NS], marker: marker({ schema: 2 }) }))).toMatchObject({ state: 'OURS_NEWER' });
    expect(view(summary({ empty: true }), marker())).toMatchObject({ state: 'OURS', initializable: false });
  });
  test('SR-02：标记合法但当前不可读（命名空间其余结构损坏或 schema 低于代码）为 UNLOADABLE', () => {
    expect(view(summary({ rootKeys: [NS], marker: marker() }))).toMatchObject({ state: 'UNLOADABLE', initializable: false });
  });
});

describe('附录 C 测试向量', () => {
  const placed = (elapsed: number) => SAFE_MODE_DURATION - elapsed;
  test('1：W，Memory 为空，safe mode 剩余 19999 → FRESH_START（a），初始化', () => {
    expect(assess(opening(19999), EMPTY, null)).toMatchObject({ mode: 'FRESH_START', strength: 'strong', case: '11.4 a', action: 'initialize' });
  });
  test('2：W，Memory 外来，safe mode 剩余 19990 → FRESH_START（b），清空', () => {
    expect(assess(opening(19990), FOREIGN, null)).toMatchObject({ mode: 'FRESH_START', strength: 'strong', case: '11.4 b', action: 'clear' });
  });
  test("3：W，Memory 外来，没有 safe mode → FRESH_START（b′），不清空；损坏时无法初始化，判为 AMBIGUOUS", () => {
    expect(assess(opening(undefined), FOREIGN, null)).toMatchObject({ mode: 'FRESH_START', strength: 'medium', case: "11.4 b'", action: 'initialize' });
    expect(assess(opening(undefined), CORRUPT, null)).toMatchObject({ mode: 'AMBIGUOUS', case: "11.4 b'", action: 'none' });
  });
  test('4：W，Memory 属于本系统，指纹中没有 S，lastRun 早于放置 → FRESH_START（c），清空', () => {
    const f = opening(placed(10));
    expect(assess(f, ours(marker({ lastRun: f.time - 50 })), null)).toMatchObject({ mode: 'FRESH_START', strength: 'strong', case: '11.4 c', action: 'clear' });
  });
  test('5：W，Memory 属于本系统，lastRun 不早于放置 → NORMAL（d）；S 在指纹中同样为 NORMAL', () => {
    const f = opening(placed(10));
    expect(assess(f, ours(marker({ lastRun: f.time - 5 })), null)).toMatchObject({ mode: 'NORMAL', case: '11.4 d' });
    expect(assess(f, ours(marker({ lastRun: 0, fp: { rooms: [], spawnIds: ['s1'], creepCount: 0 } })), null)).toMatchObject({ mode: 'NORMAL', case: '11.4 d' });
  });
  test('6 与 16：Memory 版本高于代码 → AMBIGUOUS，不论 W 是否成立', () => {
    const newer = view(summary({ rootKeys: [NS], marker: marker({ schema: 2 }) }));
    expect(assess(opening(19999), newer, null)).toMatchObject({ mode: 'AMBIGUOUS', case: '11.4 e', action: 'none' });
    expect(assess(facts({ structCount: 5, creepCount: 3 }), newer, null)).toMatchObject({ mode: 'AMBIGUOUS', case: '11.4 e' });
  });
  test('7–10（M5 的 S1 ∧ S2）：M1 判为 AMBIGUOUS，能初始化时初始化，不清空', () => {
    const seed = facts({ creepCount: 1 });
    expect(assess(seed, FOREIGN, null)).toMatchObject({ mode: 'AMBIGUOUS', strength: 'medium', case: 'M1 S1∧S2', action: 'initialize' });
    expect(assess(seed, CORRUPT, null)).toMatchObject({ mode: 'AMBIGUOUS', case: 'M1 S1∧S2', action: 'none' });
  });
  test('11–13（M2 的 T0 ∧ T2）：M1 判为 AMBIGUOUS，能初始化时初始化，不清空', () => {
    const rcl5 = facts({ spawns: [{ id: 'a', room: 'W2N2' }], structCount: 30, nonCoreCount: 28, creepCount: 20,
      controllers: [{ room: 'W2N2', level: 5, progress: 1000, safeMode: undefined }] });
    expect(assess(rcl5, EMPTY, null)).toMatchObject({ mode: 'AMBIGUOUS', case: 'M1 T0∧T2', action: 'initialize' });
    expect(assess(rcl5, FOREIGN, null)).toMatchObject({ mode: 'AMBIGUOUS', case: 'M1 T0∧T2', action: 'initialize' });
    expect(assess(rcl5, CORRUPT, null)).toMatchObject({ mode: 'AMBIGUOUS', case: 'M1 T0∧T2', action: 'none' });
  });
  test('14：Memory 属于本系统，spawn 丢失，RCL4 房间仍在 → RECOVERY；资产完整 → NORMAL', () => {
    const lost = facts({ structCount: 10, nonCoreCount: 9, creepCount: 2, controllers: [{ room: 'W1N1', level: 4, progress: 0, safeMode: undefined }] });
    expect(assess(lost, ours(), null)).toMatchObject({ mode: 'RECOVERY', case: '11.7 RECOVERY' });
    const whole = facts({ spawns: [{ id: 's0', room: 'W1N1' }], structCount: 11, nonCoreCount: 9, creepCount: 5,
      controllers: [{ room: 'W1N1', level: 4, progress: 0, safeMode: undefined }] });
    expect(assess(whole, ours(), null)).toMatchObject({ mode: 'NORMAL', case: '11.7 NORMAL' });
  });
});

describe('其余情形', () => {
  test("11.4 c′：时钟不可用时，S 与房间都不在指纹中且停运超过 GAP 才判为 FRESH_START（中）；否则 AMBIGUOUS", () => {
    const f = opening(undefined);
    const away = marker({ lastRun: f.time - GAP - 1, fp: { rooms: ['W9N9'], spawnIds: ['s0'], creepCount: 0 } });
    expect(assess(f, ours(away), null)).toMatchObject({ mode: 'FRESH_START', strength: 'medium', case: "11.4 c'", action: 'clear' });
    expect(assess(f, ours({ ...away, lastRun: f.time - GAP }), null)).toMatchObject({ mode: 'AMBIGUOUS', case: "11.4 c'" });
    expect(assess(f, ours({ ...away, fp: { rooms: ['W1N1'], spawnIds: ['s0'], creepCount: 0 } }), null)).toMatchObject({ mode: 'AMBIGUOUS' });
  });
  test('SR-02：UNLOADABLE 在 W 中按 CORRUPT 处理（时钟可用时备份后清空）；W 不成立时判为 AMBIGUOUS', () => {
    const unloadable = view(summary({ rootKeys: [NS], marker: marker() }));
    expect(assess(opening(19990), unloadable, null)).toMatchObject({ mode: 'FRESH_START', case: '11.4 b', action: 'clear' });
    expect(assess(facts({ structCount: 5 }), unloadable, null)).toMatchObject({ mode: 'AMBIGUOUS', case: '3.1 UNLOADABLE', action: 'none' });
  });
  test('已持久化的模式为 AMBIGUOUS 时，OURS 分支保持 AMBIGUOUS，等待人工确认', () => {
    const held = marker({ mode: { mode: 'AMBIGUOUS', strength: 'medium', since: 5, evidence: [] } });
    const assets = facts({ spawns: [{ id: 's0', room: 'W1N1' }], structCount: 3, creepCount: 5,
      controllers: [{ room: 'W1N1', level: 3, progress: 0, safeMode: undefined }] });
    expect(assess(assets, ours(held), null)).toMatchObject({ mode: 'AMBIGUOUS', case: '11.7 OURS 保持 AMBIGUOUS', action: 'none' });
  });
  test('没有任何资产 → DORMANT', () => {
    expect(assess(facts(), EMPTY, null)).toMatchObject({ mode: 'DORMANT', action: 'none' });
  });
  test('人工指定：FRESH_START 在 Memory 为空时初始化，否则清空；其他模式只在能初始化时初始化', () => {
    expect(assess(facts(), EMPTY, 'FRESH_START')).toMatchObject({ mode: 'FRESH_START', strength: 'strong', case: 'force', action: 'initialize' });
    expect(assess(facts(), FOREIGN, 'FRESH_START')).toMatchObject({ case: 'force', action: 'clear' });
    expect(assess(facts(), ours(), 'FRESH_START')).toMatchObject({ case: 'force', action: 'clear' });
    expect(assess(facts(), FOREIGN, 'NORMAL')).toMatchObject({ mode: 'NORMAL', case: 'force', action: 'initialize' });
    expect(assess(facts(), ours(), 'NORMAL')).toMatchObject({ mode: 'NORMAL', case: 'force', action: 'none' });
  });
});
