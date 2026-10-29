/**
 * 文件摘要：CPU 硬终止后的恢复（审计 S-01、S-02，补附录 X-02 的缺口），以真实的入口 createEntry、kernel 与 app.boot 驱动。
 * 平台替身的 timeout 选项在 node:vm 中运行 tick：V8 的终止不执行 catch 与 finally，本 tick 的结果整体作废，heap 保留，
 * 与公开 driver 的 CPU 超时一致（test/platform/memory.ts 文件摘要）。终止点用 jest.spyOn 注入：被选中的调用空转到超时。
 * 覆盖：
 * - Memory 首次加载被终止（概要已算出、数据尚未装好）：下一 tick 丢弃实例并运行保底，再下一 tick 新实例完成加载，
 *   生存层模块 setup 并运行，Memory 为 ready；
 * - 只有外来根键时同样被终止：新实例在完整加载的根上初始化，外来键保留（11.4 b′），不在空根上初始化；
 * - 模块 setup 被终止：新实例重新 setup 全部模块，排在后面的模块照常运行。
 * 反向验证：入口不检测终止时（基线 cb51f01），三项都失败。
 */
import { type BootFacts, createBoot } from '@/app/boot';
import type { UnitSpec } from '@/contracts/memory';
import type { ModuleDefinition } from '@/contracts/module';
import * as json from '@/kernel/memory/json';
import type { Kernel } from '@/kernel/lifecycle';
import { createEntry } from '@/main';
import { READY_MEMORY, kernelHarness } from '../kernel/lifecycle/harness';

/** 模拟 CPU 超时的毫秒数；空转的调用超过它即被终止。 */
const TIMEOUT_MS = 30;

/** 一个运营中的 RCL3 房间，不是开局世界：本项目命名空间缺失而能加载时，boot 判为 AMBIGUOUS 并初始化。 */
const WORLD: BootFacts = {
  time: 0, spawns: [{ id: 's0', room: 'W1N1' }], structCount: 6, nonCoreCount: 4, sites: 0, creepCount: 4, pcHere: 0,
  controllers: [{ room: 'W1N1', level: 3, progress: 100, safeMode: undefined }],
};

/** 计数分区的声明；跨实例共用同一对象。 */
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
 * @description 空转到被 vm 的 timeout 终止；不在 vm 中运行时（反向验证）1 秒后抛错，避免测试卡死。
 * @returns 不返回。
 * @throws {Error} 空转 1 秒仍未被终止。
 */
const spin = (): never => {
  const end = Date.now() + 1000;
  while (Date.now() < end) { /* 空转 */ }
  throw new Error('spin 未被终止');
};

/**
 * @description 搭建入口、kernel 与 boot：模块每次 act 把自己分区的计数加 1，并记录 setup 与运行。
 * @param options 可选项。
 * @param options.memory 初始 Memory 文本，默认已初始化。
 * @param options.spinSetup 为 true 时第一个模块的第一次 setup 空转（模拟 setup 被终止）。
 * @returns 推进 tick 的函数与观测数据。
 */
const setup = (options: { memory?: string; spinSetup?: boolean } = {}) => {
  const state = { t: 0 };
  const seen = { setups: [] as string[], acts: [] as string[], fallbacks: [] as number[], reports: [] as string[] };
  let spinSetup = options.spinSetup ?? false;
  /**
   * @description 构造计数模块。
   * @param id 模块 id。
   * @returns 生存层模块定义。
   */
  const module = (id: string): ModuleDefinition => ({
    id, tier: 'survival', priority: id === 'a' ? 0 : 1,
    setup: (ctx) => {
      if (id === 'a' && spinSetup) { spinSetup = false; spin(); }
      seen.setups.push(id);
      const part = ctx.memory.partition('state', COUNTER);
      return {
        act: () => {
          part.set(['n'], (part.get(['n']) as number) + 1);
          seen.acts.push(`${id}@${state.t}`);
        },
      };
    },
  });
  const boot = createBoot({
    identity: { namespace: 'leviathan', schema: 1 }, release: 'termination',
    settings: { autoClear: true, dryRun: false },
    /**
     * @description 当前 tick。
     * @returns tick。
     */
    time: () => state.t,
    /**
     * @description 世界事实。
     * @returns 当前 tick 的事实。
     */
    facts: () => ({ ...WORLD, time: state.t }),
    /**
     * @description 廉价不变量。
     * @returns 固定的计数。
     */
    counts: () => ({ spawns: 1, structures: WORLD.structCount, creeps: WORLD.creepCount }),
    /**
     * @description 通知在本测试中丢弃。
     * @returns 无返回值。
     */
    notify: () => undefined,
  });
  const memory = options.memory ?? READY_MEMORY.replace('"spawnIds":[]', '"spawnIds":["s0"]');
  const h = kernelHarness({ modules: [module('a'), module('b')], memory, boot, game: {
    /**
     * @description 当前 tick。
     * @returns tick。
     */
    time: () => state.t,
  } });
  let assembled = 0;
  let kernel: Kernel | undefined;
  const loop = createEntry({
    /**
     * @description kernel 的 Memory 实例自行接管。
     * @returns 无返回值。
     */
    takeover: () => undefined,
    /**
     * @description 第一次用宿主已建好的实例，之后经宿主重建。
     * @returns kernel。
     */
    assemble: (): Kernel => {
      assembled += 1;
      if (assembled > 1) h.rebuild();
      kernel = h.kernel;
      return kernel;
    },
    /**
     * @description 记录保底运行的 tick。
     * @returns 无返回值。
     */
    fallback: () => { seen.fallbacks.push(state.t); },
    /**
     * @description 当前 tick。
     * @returns tick。
     */
    time: () => state.t,
    /**
     * @description 通知在本测试中丢弃。
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
  /**
   * @description 推进一个 tick。
   * @param terminated 是否以超时运行（注入的空转会被终止）。
   * @returns 本 tick 的错误；终止时为超时错误。
   */
  const step = (terminated = false): unknown => {
    state.t += 1;
    return h.platform.tick(() => loop(), terminated ? { timeout: TIMEOUT_MS } : {}).error;
  };
  return { step, seen, h, kernel: () => kernel! };
};

afterEach(() => { jest.restoreAllMocks(); });

test('S-01：Memory 首次加载被终止后，下一 tick 运行保底并丢弃实例，新实例完成加载、模块 setup 并运行', () => {
  const { step, seen, h, kernel } = setup();
  jest.spyOn(json, 'checkParsed').mockImplementationOnce(spin);
  expect(String(step(true))).toMatch(/timed out/);
  expect(step()).toBeUndefined();
  expect(seen.fallbacks).toEqual([2]);
  expect(seen.reports[0]).toContain('CPU 硬终止');
  expect(step()).toBeUndefined();
  expect(seen.setups).toEqual(['a', 'b']);
  expect(seen.acts).toEqual(['a@3', 'b@3']);
  expect(kernel().ops.status()).toMatchObject({ memory: 'ready', health: 'ok' });
  const root = JSON.parse(h.platform.memory) as { leviathan: { part: Record<string, { state: { data: { n: number } } }> } };
  expect(root.leviathan.part.a.state.data.n).toBe(1);
});

test('S-01：只有外来根键时加载被终止，新实例在完整加载的根上初始化，外来键保留', () => {
  const { step, h } = setup({ memory: JSON.stringify({ foreign: { keep: 1 } }) });
  jest.spyOn(json, 'checkParsed').mockImplementationOnce(spin);
  step(true);
  step();
  step();
  const root = JSON.parse(h.platform.memory) as Record<string, unknown>;
  expect(Object.keys(root)).toEqual(['foreign', 'leviathan']);
  expect(root.foreign).toEqual({ keep: 1 });
});

test('S-02：模块 setup 被终止后，新实例重新 setup 全部模块，排在后面的模块照常运行', () => {
  const { step, seen, kernel } = setup({ spinSetup: true });
  expect(String(step(true))).toMatch(/timed out/);
  step();
  step();
  expect(seen.setups).toEqual(['a', 'b']);
  expect(seen.acts).toEqual(['a@3', 'b@3']);
  expect(kernel().ops.status().modules.map((m) => m.state)).toEqual(['running', 'running']);
});
