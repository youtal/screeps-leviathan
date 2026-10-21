/**
 * 文件摘要：app.boot 宿主（src/app/boot/index.ts）的集成测试：以真实 kernel、Memory 平台替身与构造的世界事实驱动。
 * 覆盖：开局初始化（11.4 a）；外来 Memory 的备份与清空（b）；运行中途重生先软重置、新实例再备份清空（附录 C 用例 15）；
 * 中证据须两次判定一致（c′）；dryRun；autoClear 关闭与备份失败时改判 AMBIGUOUS；M1 接手分支初始化后保持 AMBIGUOUS、
 * boot.force 的生效与跨重建保留；廉价不变量；项目标记的维护（lastRun、release、fp 与 RECOVERY 时不更新）；
 * 模式变化只通知一次；控制台命令。
 */
import { type BootFacts, createBoot } from '@/app/boot';
import type { BootDefinition } from '@/contracts/boot';
import type { BootSettings } from '@/contracts/settings';
import { BACKUP_CAPACITY } from '@/kernel/bootPort';
import { decodePage } from '@/kernel/segments';
import { READY_MEMORY, kernelHarness } from '../../kernel/lifecycle/harness';

/**
 * @description 构造世界事实，默认没有任何资产；time 由宿主在读取时填入。
 * @param o 覆盖的字段。
 * @returns 事实。
 */
const facts = (o: Partial<BootFacts> = {}): BootFacts => ({
  time: 0, spawns: [], structCount: 0, nonCoreCount: 0, sites: 0, creepCount: 0, pcHere: 0, controllers: [], ...o,
});

/**
 * @description 开局世界 W：房间里一个 spawn 与一个 RCL1 的 controller。
 * @param safeMode safe mode 剩余 tick；undefined 表示时钟不可用。
 * @param spawn spawn id。
 * @param room 房间名。
 * @returns 事实。
 */
const opening = (safeMode: number | undefined, spawn = 's1', room = 'W1N1'): BootFacts => facts({
  spawns: [{ id: spawn, room }], structCount: 2, controllers: [{ room, level: 1, progress: 0, safeMode }],
});

/** 一个运营中的 RCL3 房间。 */
const RUNNING = facts({ spawns: [{ id: 's0', room: 'W1N1' }], structCount: 6, nonCoreCount: 4, creepCount: 4,
  controllers: [{ room: 'W1N1', level: 3, progress: 100, safeMode: undefined }] });

/**
 * @description 创建 boot 测试宿主：真实 kernel 加 createBoot，世界事实与时间由测试控制。
 * @param o 选项。
 * @param o.memory 初始 Memory 文本，默认为空。
 * @param o.world 初始世界事实。
 * @param o.settings 覆盖的使用者设置。
 * @param o.wrap 包装 boot 定义，用于替换上下文中的部分能力；默认不包装。
 * @returns kernel 宿主、推进一个 tick 的 step、可替换的世界、通知与事实读取次数。
 */
const bootHarness = (o: { memory?: string; world: BootFacts; settings?: Partial<BootSettings>;
  wrap?: (def: BootDefinition) => BootDefinition }) => {
  const state = { t: 0, world: o.world, factReads: 0 };
  const notices: string[] = [];
  const boot = createBoot({
    identity: { namespace: 'leviathan', schema: 1 }, release: 'r1',
    settings: { autoClear: true, dryRun: false, ...o.settings },
    /**
     * @description 当前 tick。
     * @returns 测试控制的 tick。
     */
    time: () => state.t,
    /**
     * @description 读取世界事实并计数。
     * @returns 当前世界。
     */
    facts: () => { state.factReads += 1; return { ...state.world, time: state.t }; },
    /**
     * @description 由当前世界得出廉价不变量。
     * @returns 计数。
     */
    counts: () => ({ spawns: state.world.spawns.length, structures: state.world.structCount, creeps: state.world.creepCount }),
    /**
     * @description 记录通知。
     * @param m 通知正文。
     * @returns 无返回值。
     */
    notify: (m) => { notices.push(m); },
  });
  const h = kernelHarness({ modules: [], memory: o.memory ?? '', boot: o.wrap ? o.wrap(boot) : boot, game: { time: () => state.t } });
  /**
   * @description 推进一个 tick。
   * @returns 本 tick 的健康状态。
   */
  const step = () => { state.t += 1; return h.tick(); };
  /**
   * @description 读取持久化的项目标记。
   * @returns sys；命名空间不存在时为 undefined。
   */
  const sys = () => (h.platform.memory ? JSON.parse(h.platform.memory).leviathan?.sys : undefined);
  return { h, step, state, notices, sys };
};

/** 带外来根键的 Memory 文本。 */
const FOREIGN_TEXT = JSON.stringify({ other: { data: 1 } });

test('11.4 a：开局且 Memory 为空 → 初始化，写入 FRESH_START、指纹与版本号，只通知一次', () => {
  const b = bootHarness({ world: opening(19999) });
  expect(b.step()).toBe('ok');
  expect(b.sys()).toMatchObject({ epoch: 1, release: 'r1', lastRun: 1,
    fp: { rooms: ['W1N1'], spawnIds: ['s1'], creepCount: 0 }, mode: { mode: 'FRESH_START', strength: 'strong', since: 1 } });
  b.step();
  expect(b.sys().lastRun).toBe(2);
  expect(b.notices).toHaveLength(1);
  expect(b.notices[0]).toContain('FRESH_START');
});

test('11.4 b：开局且 Memory 外来 → 备份期间为暂停 tick，备份完成后清空，外来根键被移除', () => {
  const b = bootHarness({ memory: FOREIGN_TEXT, world: opening(19990) });
  expect([b.step(), b.step(), b.step()]).toEqual(['paused', 'paused', 'ok']);
  const saved = JSON.parse(b.h.platform.memory);
  expect(Object.keys(saved)).toEqual(['leviathan']);
  expect(saved.leviathan.sys).toMatchObject({ epoch: 1, mode: { mode: 'FRESH_START', strength: 'strong' } });
  expect(decodePage(b.h.platform.segment(80) ?? '')?.body).toBe(FOREIGN_TEXT);
  expect(b.notices).toHaveLength(1);
});

test('附录 C 用例 15：运行中途重生 → 先软重置，新实例重新判定、备份并清空', () => {
  const memory = READY_MEMORY.replace('"spawnIds":[]', '"spawnIds":["s0"]');
  const b = bootHarness({ memory, world: RUNNING });
  for (let i = 0; i < 3; i += 1) expect(b.step()).toBe('ok');
  expect(b.sys().mode.mode).toBe('NORMAL');
  // 重生：时间推进，新的 spawn 放在另一房间，safe mode 时钟表明 10 tick 前放置。
  b.state.t = 1000;
  b.state.world = opening(19990, 's9', 'W5N5');
  expect(b.step()).toBe('paused');
  expect(b.h.kernel.resetRequested()).toBe(true);
  b.h.rebuild();
  const health = [b.step(), b.step(), b.step()];
  expect(health).toEqual(['paused', 'paused', 'ok']);
  expect(b.sys()).toMatchObject({ epoch: 1, fp: { spawnIds: ['s9'] }, mode: { mode: 'FRESH_START' } });
});

test("11.4 c′：中证据第一次判定只开始备份，不清空；第二次判定一致且备份完成后清空", () => {
  const memory = READY_MEMORY.replace('"rooms":[]', '"rooms":["W9N9"]').replace('"spawnIds":[]', '"spawnIds":["s0"]');
  const b = bootHarness({ memory, world: opening(undefined) });
  b.state.t = 499;
  expect(b.step()).toBe('paused');
  expect(b.sys().epoch).toBe(0);
  const rest = [b.step(), b.step()];
  expect(rest[rest.length - 1]).toBe('ok');
  expect(b.sys()).toMatchObject({ epoch: 1, mode: { mode: 'FRESH_START', strength: 'medium' } });
});

test('dryRun：只判定与发布，不初始化、不写 Memory；通知注明 dryRun', () => {
  const b = bootHarness({ world: opening(19999), settings: { dryRun: true } });
  b.step(); b.step();
  expect(b.h.platform.memory).toBe('');
  expect(b.notices).toHaveLength(1);
  expect(b.notices[0]).toContain('dryRun');
});

test('autoClear 关闭：开局外来 Memory 不清空，改判 AMBIGUOUS 并初始化，外来根键保留', () => {
  const b = bootHarness({ memory: FOREIGN_TEXT, world: opening(19990), settings: { autoClear: false } });
  expect(b.step()).toBe('ok');
  const saved = JSON.parse(b.h.platform.memory);
  expect(saved.other).toEqual({ data: 1 });
  expect(saved.leviathan.sys.mode).toMatchObject({ mode: 'AMBIGUOUS', strength: 'medium' });
  expect(saved.leviathan.sys.mode.evidence).toContain('autoClear 关闭，未清空');
});

test('备份失败：不清空，改判 AMBIGUOUS 并初始化', () => {
  const big = JSON.stringify({ other: 'y'.repeat(BACKUP_CAPACITY) });
  const b = bootHarness({ memory: big, world: opening(19990) });
  expect(b.step()).toBe('ok');
  const saved = JSON.parse(b.h.platform.memory);
  expect(saved.other).toBeDefined();
  expect(saved.leviathan.sys.mode.evidence).toContain('备份失败，未清空');
});

test('autoClear 关闭：本系统 Memory 遇到重生 → AMBIGUOUS，冻结 lastRun 与 fp；重建后仍为 AMBIGUOUS，不改判 NORMAL', () => {
  const memory = READY_MEMORY.replace('"spawnIds":[]', '"spawnIds":["s0"]');
  const b = bootHarness({ memory, world: opening(19990, 's9', 'W5N5'), settings: { autoClear: false } });
  // 第 1001 tick：safe mode 时钟表明 10 tick 前放置，lastRun 为 1，s9 不在指纹中 → 11.4 c 被 autoClear 拦下。
  b.state.t = 1000;
  b.step(); b.step();
  expect(b.sys()).toMatchObject({ lastRun: 1, fp: { spawnIds: ['s0'] }, mode: { mode: 'AMBIGUOUS', strength: 'medium' } });
  b.h.rebuild();
  b.step();
  expect(b.sys()).toMatchObject({ lastRun: 1, fp: { spawnIds: ['s0'] }, mode: { mode: 'AMBIGUOUS' } });
  expect(b.sys().mode.evidence).toContain('autoClear 关闭，未清空');
  expect(b.notices).toHaveLength(1);
});

test("ultrareview 第 2 项：11.4 c′ 因房间在指纹中判为 AMBIGUOUS 后不写指纹，lastRun 照常前进；重建后仍为 AMBIGUOUS", () => {
  const memory = READY_MEMORY.replace('"rooms":[]', '"rooms":["W1N1"]').replace('"spawnIds":[]', '"spawnIds":["s0"]');
  const b = bootHarness({ memory, world: opening(undefined, 's9', 'W1N1') });
  b.state.t = 1000;
  b.step(); b.step();
  expect(b.sys()).toMatchObject({ lastRun: 1002, fp: { spawnIds: ['s0'] }, mode: { mode: 'AMBIGUOUS', strength: 'medium' } });
  b.h.rebuild();
  b.step();
  expect(b.sys()).toMatchObject({ lastRun: 1003, fp: { spawnIds: ['s0'] }, mode: { mode: 'AMBIGUOUS' } });
  expect(b.notices).toHaveLength(1);
});

test("ultrareview 第 2 项：11.4 c′ 因停运不足 GAP 判为 AMBIGUOUS 后，运行超过 GAP 再重建仍为 AMBIGUOUS，不伪造停运证据", () => {
  const memory = READY_MEMORY.replace('"rooms":[]', '"rooms":["W9N9"]').replace('"spawnIds":[]', '"spawnIds":["s0"]');
  const b = bootHarness({ memory, world: opening(undefined, 's9', 'W1N1') });
  b.state.t = 50;
  b.step();
  expect(b.sys().mode).toMatchObject({ mode: 'AMBIGUOUS', evidence: expect.arrayContaining(['时钟不可用，且房间在指纹中或停运时间不足']) });
  for (let i = 0; i < 150; i += 1) b.step();
  b.h.rebuild();
  b.step();
  expect(b.sys()).toMatchObject({ epoch: 0, fp: { spawnIds: ['s0'] }, mode: { mode: 'AMBIGUOUS' } });
});

test('control 分区申请失败：异常传播为 boot 失败，boot.force 返回错误而不是静默丢失人工指定', () => {
  const b = bootHarness({ world: RUNNING, wrap: (def) => ({
    /**
     * @description 以分区申请总是失败的上下文调用原 setup。
     * @param ctx kernel 提供的 boot 上下文。
     * @returns 原 boot 钩子。
     */
    setup: (ctx) => def.setup(Object.create(ctx, { memory: { value: {
      /**
       * @description 模拟声明冲突。
       * @returns 不返回。
       * @throws {Error} 总是抛出。
       */
      partition: () => { throw new Error('分区声明冲突'); },
    } } })),
  }) });
  b.step();
  expect(b.h.lines.some((l) => l.includes('boot 失败'))).toBe(true);
  const boot = b.h.globals.boot as { force: (mode?: string) => string };
  expect(boot.force('NORMAL')).toContain('分区声明冲突');
});

test('M1 接手分支：有资产而 Memory 为空 → AMBIGUOUS 并初始化；重建后保持，boot.force 生效并跨重建保留，取消后恢复自动判定', () => {
  const b = bootHarness({ world: RUNNING });
  b.step();
  expect(b.sys().mode).toMatchObject({ mode: 'AMBIGUOUS', strength: 'medium' });
  b.h.rebuild();
  b.step();
  expect(b.sys().mode.mode).toBe('AMBIGUOUS');
  expect(b.sys().mode.evidence.join()).toContain('等待人工');
  const boot = b.h.globals.boot as { force: (mode?: string) => string };
  // 控制台捕获处理函数的异常，返回错误文本（console 设计第 3 节）。
  expect(boot.force('BOGUS')).toContain('错误');
  boot.force('NORMAL');
  b.step();
  expect(b.sys().mode).toMatchObject({ mode: 'NORMAL', strength: 'strong' });
  expect(JSON.parse(b.h.platform.memory).leviathan.part.boot.control.data.force).toBe('NORMAL');
  b.h.rebuild();
  b.step();
  expect(b.sys().mode.evidence).toContain('人工指定（boot.force）');
  (b.h.globals.boot as { force: () => string }).force();
  b.step();
  expect(b.sys().mode).toMatchObject({ mode: 'NORMAL' });
  expect(b.sys().mode.evidence).not.toContain('人工指定（boot.force）');
  expect(b.notices.map((n) => n.split('启动判定 ')[1].split('（')[0])).toEqual(['AMBIGUOUS', 'NORMAL']);
});

test('廉价不变量：creep 数的日常增减不触发完整判定；creep 归零、spawn 数变化触发', () => {
  const b = bootHarness({ memory: READY_MEMORY.replace('"spawnIds":[]', '"spawnIds":["s0"]'), world: RUNNING });
  b.step(); b.step(); b.step();
  expect(b.state.factReads).toBe(1);
  b.state.world = { ...RUNNING, creepCount: 5 };
  b.step();
  expect(b.state.factReads).toBe(1);
  b.state.world = { ...RUNNING, creepCount: 0 };
  b.step();
  expect(b.state.factReads).toBe(2);
  b.state.world = { ...RUNNING, creepCount: 0, spawns: [] };
  b.step();
  expect(b.state.factReads).toBe(3);
  expect(b.sys().mode.mode).toBe('RECOVERY');
});

test('项目标记：lastRun 每 tick、release 每个实例写一次、fp 每 100 tick 更新；RECOVERY 期间不更新 fp', () => {
  const memory = READY_MEMORY.replace('"spawnIds":[]', '"spawnIds":["s0"]');
  const b = bootHarness({ memory, world: RUNNING });
  b.state.t = 97;
  b.step();
  expect(b.sys()).toMatchObject({ lastRun: 98, release: 'r1', fp: { creepCount: 4 } });
  b.state.world = { ...RUNNING, creepCount: 5 };
  b.step();
  expect(b.sys().fp.creepCount).toBe(4);
  b.step();
  expect(b.sys()).toMatchObject({ lastRun: 100, fp: { creepCount: 5 } });
  // spawn 丢失 → RECOVERY；指纹保留丢失前的资产。
  b.state.world = { ...RUNNING, spawns: [], creepCount: 5 };
  b.step();
  expect(b.sys().mode.mode).toBe('RECOVERY');
  b.state.t = 199;
  b.step();
  expect(b.sys().fp.spawnIds).toEqual(['s0']);
});

test('控制台：boot.assess() 只判定不发布；boot.dryRun 读写设置，非布尔值被拒绝', () => {
  const b = bootHarness({ world: opening(19999) });
  // 命名空间在第一个 tick 的 boot setup 中注册。
  b.step();
  const boot = b.h.globals.boot as { assess: () => string; dryRun: unknown };
  expect(boot.assess()).toContain('NORMAL');
  expect(b.sys().mode.mode).toBe('FRESH_START');
  expect(boot.dryRun).toBe(false);
  boot.dryRun = true;
  expect(boot.dryRun).toBe(true);
  boot.dryRun = 'yes';
  expect(boot.dryRun).toBe(true);
  expect(b.h.lines.some((l) => l.includes('boot.dryRun 写入被拒绝'))).toBe(true);
});
