/**
 * 文件摘要：第 5 步接入 lifecycle 后的集成测试：启停标志、恢复熔断、状态快照、模块的控制台命令、
 * CPU 准入与计量（每次钩子调用一次读数）、紧急刹车与统计页写出。以 kernel 测试宿主驱动。
 */
import type { PhaseHooks } from '@/contracts/context';
import type { Tier } from '@/contracts/cpu';
import type { ModuleDefinition } from '@/contracts/module';
import { decodePage } from '@/kernel/segments';
import { STATS_INTERVAL, STATS_PAGE } from '@/kernel/stats';
import { READY_MEMORY, kernelHarness, marker } from './harness';

/**
 * @description 构造记录 plan 调用的模块。
 * @param id 模块 id。
 * @param calls 调用记录。
 * @param options 可选项。
 * @param options.tier 层级，默认 economy。
 * @param options.requires 硬依赖。
 * @param options.startPaused 清单默认暂停。
 * @param options.hooks 覆盖默认钩子。
 * @param options.instances 在 setup 中添加的实例键，实例的 plan 记为 `<id>:<键>`。
 * @returns 模块定义。
 */
const mod = (id: string, calls: string[], options: { tier?: Tier; requires?: string[]; startPaused?: boolean;
  hooks?: PhaseHooks; instances?: string[] } = {}): ModuleDefinition => ({
  id, tier: options.tier ?? 'economy', priority: 0, requires: options.requires, startPaused: options.startPaused,
  setup: (ctx) => {
    for (const key of options.instances ?? []) ctx.processes.add(key, () => ({ plan: () => { calls.push(`${id}:${key}`); } }));
    return options.hooks ?? { plan: () => { calls.push(id); } };
  },
});

describe('启停标志', () => {
  test('startPaused 默认不运行；resume 下一 tick 生效；unset 恢复默认；暂停传递到实例与依赖模块', () => {
    const calls: string[] = [];
    const h = kernelHarness({ modules: [mod('a', calls, { startPaused: true, instances: ['x'] }), mod('b', calls, { requires: ['a'] })] });
    h.tick();
    expect(calls).toEqual([]);
    expect(h.kernel.ops.status().modules.map((m) => m.state)).toEqual(['paused', 'blocked']);
    h.kernel.ops.setSwitch('a', 'run');
    h.tick();
    expect(calls).toEqual(['a', 'a:x', 'b']);
    expect(JSON.parse(h.platform.memory).leviathan.part.kernel.switches.data).toEqual({ a: 'run' });
    calls.length = 0;
    h.kernel.ops.setSwitch('a', undefined);
    h.tick();
    expect(calls).toEqual([]);
    h.kernel.ops.setSwitch('b', 'pause');
    h.kernel.ops.setSwitch('a', 'run');
    h.tick();
    expect(calls).toEqual(['a', 'a:x']);
  });

  test('暂停不计熔断、不影响健康；生存层不能暂停，手工写入的 pause 记录被忽略并告警一次；未知 id 告警一次', () => {
    const calls: string[] = [];
    const memory = JSON.stringify({ ...JSON.parse(READY_MEMORY) });
    const parsed = JSON.parse(memory);
    parsed.leviathan.part = { kernel: { switches: { version: 1, data: { s: 'pause', ghost: 'pause' } } } };
    const h = kernelHarness({ memory: JSON.stringify(parsed), modules: [mod('s', calls, { tier: 'survival' }), mod('e', calls)] });
    expect(h.tick()).toBe('ok');
    h.kernel.ops.setSwitch('e', 'pause');
    expect([h.tick(), h.tick()]).toEqual(['ok', 'ok']);
    expect(calls).toEqual(['s', 'e', 's', 's']);
    expect(() => h.kernel.ops.setSwitch('s', 'pause')).toThrow('生存层');
    expect(() => h.kernel.ops.setSwitch('nope', 'pause')).toThrow('未知模块');
    expect(h.lines.filter((l) => l.includes('不能暂停'))).toHaveLength(1);
    expect(h.lines.filter((l) => l.includes('未知模块 ghost'))).toHaveLength(1);
  });

  test('Memory 为 empty 时不能写入启停标志，按清单默认值运行', () => {
    const h = kernelHarness({ memory: '', modules: [mod('e', [])] });
    h.tick();
    expect(() => h.kernel.ops.setSwitch('e', 'pause')).toThrow('Memory 不可用');
  });
});

describe('恢复熔断与状态', () => {
  test('recover 清除模块与实例的熔断，不重新 setup；初始化失败的模块不能恢复', () => {
    const calls: string[] = [];
    let moduleFails = true;
    let instanceFails = true;
    let setups = 0;
    const flaky: ModuleDefinition = { id: 'flaky', tier: 'economy', priority: 0,
      setup: (ctx) => {
        setups += 1;
        ctx.processes.add('i', () => ({ plan: () => { if (instanceFails) throw new Error('实例坏了'); calls.push('i'); } }));
        return { plan: () => { if (moduleFails) throw new Error('坏了'); calls.push('flaky'); } };
      } };
    const broken: ModuleDefinition = { id: 'dead', tier: 'economy', priority: 0, setup: () => { throw new Error('起不来'); } };
    const h = kernelHarness({ modules: [flaky, broken] });
    h.tick(); h.tick(); h.tick(); // 模块第 3 次失败时熔断；实例在前两个 tick 失败 2 次
    expect(h.kernel.ops.status().modules.map((m) => [m.id, m.state])).toEqual([['dead', 'failed'], ['flaky', 'broken']]);
    moduleFails = false;
    h.kernel.ops.recover('flaky');
    h.tick(); // 模块恢复；实例第 3 次失败，熔断
    instanceFails = false;
    h.tick();
    expect(calls).toEqual(['flaky', 'flaky']);
    expect(h.kernel.ops.status().modules[1].brokenInstances).toBe(1);
    h.kernel.ops.recover('flaky:i');
    h.tick();
    expect(calls).toEqual(['flaky', 'flaky', 'flaky', 'i']);
    expect(setups).toBe(1);
    expect(() => h.kernel.ops.recover('dead')).toThrow('初始化失败');
    expect(() => h.kernel.ops.recover('flaky:none')).toThrow('未知进程');
  });

  test('状态快照：健康、Memory 状态、预算与每个模块的平滑耗用和实例数', () => {
    const h = kernelHarness({ modules: [mod('a', [], { instances: ['x', 'y'] })] });
    const before = h.kernel.ops.status();
    expect([before.health, before.modules[0].state]).toEqual([undefined, 'pending']);
    h.tick();
    const s = h.kernel.ops.status();
    expect([s.health, s.memory, s.release, s.budget, s.reserve]).toEqual(['ok', 'ready', 'test-release', 25, 2.5]);
    expect(s.modules[0]).toMatchObject({ id: 'a', state: 'running', instances: 2, brokenInstances: 0, cost: 0, starve: 0 });
  });

  test('ops.logger 取得模块与实例的 Logger，用于修改作用域覆盖', () => {
    const h = kernelHarness({ modules: [mod('a', [], { instances: ['x'] })] });
    h.tick();
    h.kernel.ops.logger('a').configLevel({ debug: true });
    expect(h.kernel.ops.logger('a:x').enabled('debug')).toBe(true);
    expect(() => h.kernel.ops.logger('zz')).toThrow('未知进程');
  });
});

describe('控制台', () => {
  test('模块经 ctx.console 注册的命令安装在全局目标上；kernel 销毁后换为桩对象；宿主命名空间不得与模块 id 冲突', () => {
    const m: ModuleDefinition = { id: 'probe', tier: 'economy', priority: 0,
      setup: (ctx) => { ctx.console.command('hello', '问候', (name?: unknown) => `你好 ${String(name)}`); return {}; } };
    const h = kernelHarness({ modules: [m] });
    h.tick();
    const probe = h.globals.probe as Record<string, (...args: unknown[]) => string>;
    expect(probe.hello('W1N1')).toBe('你好 W1N1');
    expect(() => h.kernel.console('probe')).toThrow(TypeError);
    h.kernel.dispose();
    expect((h.globals.probe as Record<string, () => string>).hello()).toContain('kernel 未运行');
  });
});

describe('CPU', () => {
  test('计量：每次钩子调用只增加一次 CPU 读数，耗用计入进程的平滑耗用', () => {
    let used = 0;
    let reads = 0;
    const work = (): void => { used += 2; };
    const hooks: PhaseHooks = { sense: work, plan: work, arbitrate: work, act: work, move: work };
    const busy: ModuleDefinition = { id: 'busy', tier: 'economy', priority: 0,
      setup: (ctx) => { ctx.processes.add('i', () => ({ ...hooks })); return hooks; } };
    const idle: ModuleDefinition = { id: 'busy', tier: 'economy', priority: 0, setup: () => ({}) };
    /**
     * @description 运行两个 tick（第一个 tick 含 setup），返回第二个 tick 的读数次数。
     * @param def 模块定义。
     * @returns 读数次数。
     */
    const readsOf = (def: ModuleDefinition) => {
      const h = kernelHarness({ modules: [def], game: { cpuUsed: () => { reads += 1; return used; } } });
      // 游戏中 getUsed 每 tick 从 0 开始；读数不归零时第二个 tick 的预计值会超过上限。
      used = 0;
      h.tick();
      reads = 0;
      used = 0;
      h.tick();
      return { reads, h };
    };
    const quiet = readsOf(idle).reads;
    const { reads: loud, h } = readsOf(busy);
    expect(loud - quiet).toBe(10); // 模块与实例各 5 个钩子
    expect(h.kernel.ops.status().modules[0].cost).toBe(10);
  });

  test('紧急刹车：读数到达 hardEnd 后跳过剩余的非生存层钩子，生存层照常运行，只告警一次', () => {
    const calls: string[] = [];
    let used = 0;
    const greedy: ModuleDefinition = { id: 'greedy', tier: 'economy', priority: 0,
      setup: () => ({ plan: () => { calls.push('greedy'); used = 10000; } }) };
    const h = kernelHarness({ modules: [mod('s', calls, { tier: 'survival', hooks: { act: () => { calls.push('s.act'); } } }),
      greedy, mod('later', calls)], game: { cpuUsed: () => used } });
    h.tick();
    expect(calls).toEqual(['greedy', 's.act']);
    expect(h.lines.filter((l) => l.includes('跳过剩余的非生存层钩子'))).toHaveLength(1);
  });

  test('ultrareview 第 3 项：被紧急刹车跳过的模块改记为落选，连续落选次数加 1，它的实例同样跳过', () => {
    const calls: string[] = [];
    let used = 0;
    const greedy: ModuleDefinition = { id: 'greedy', tier: 'economy', priority: 0,
      setup: () => ({ plan: () => { calls.push('greedy'); used = 10000; } }) };
    const h = kernelHarness({ modules: [greedy, mod('later', calls, { instances: ['x'] })], game: { cpuUsed: () => used } });
    h.tick();
    expect(calls).toEqual(['greedy']);
    expect(h.kernel.ops.status().modules.find((m) => m.id === 'later')).toMatchObject({ starve: 1 });
  });

  test('预算放不下的模块落选，不运行，连续落选次数可见', () => {
    const calls: string[] = [];
    let used = 0;
    const heavy: ModuleDefinition = { id: 'heavy', tier: 'economy', priority: 0,
      setup: () => ({ plan: () => { calls.push('heavy'); used += 30; } }) };
    const h = kernelHarness({ modules: [heavy], game: { cpuUsed: () => used } });
    h.tick(); // 预热：预计值为 0，准入，样本 30
    used = 0;
    h.tick(); // 30 > poolEnd 22.5，落选
    expect(calls).toEqual(['heavy']);
    expect(h.kernel.ops.status().modules[0]).toMatchObject({ starve: 1 });
  });
});

test('LC-06：Memory 维护是收尾任务，非生存层预算用尽时仍每 tick 运行，回收已消失的 creep 记录', () => {
  const text = JSON.stringify({ leviathan: { sys: marker, part: {}, rooms: {},
    creeps: { gone: { m: { version: 1, data: {} } } }, flags: {} } });
  const calls: string[] = [];
  const h = kernelHarness({ memory: text, modules: [mod('e', calls)], game: { cpuUsed: () => 1000 } });
  h.tick(); h.tick(); h.tick();
  expect(calls).toEqual([]); // 预算用尽：经济层模块不运行
  expect(JSON.parse(h.platform.memory).leviathan.creeps).toEqual({});
});

test('统计：每 STATS_INTERVAL 个 tick 写出第 50 页', () => {
  const h = kernelHarness({ modules: [mod('a', [])] });
  for (let i = 0; i < STATS_INTERVAL; i += 1) h.tick();
  h.tick(); // segments 在下一 tick 的提交中写出（本 tick 的提交已写出），确保页已落盘
  const page = decodePage(h.platform.segment(STATS_PAGE) ?? '');
  expect(page?.header).toMatchObject({ v: 1, o: 'stats', g: STATS_INTERVAL });
  const body = JSON.parse(page!.body);
  expect(body).toMatchObject({ t: STATS_INTERVAL, n: STATS_INTERVAL, release: 'test-release', mode: 'AMBIGUOUS', paused: [], down: [] });
  expect(body.memory.total).toBeGreaterThan(0);
});

test('PA-03：统计页写出 kernel 收尾耗用与体积最大的 owner', () => {
  // 每次读取 CPU 递增 1：收尾耗用等于维护之前与统计采集之间的读数次数，可以确定地检验。
  let reading = 0;
  const h = kernelHarness({ modules: [mod('a', [])], game: { cpuUsed: () => (reading += 1) } });
  for (let i = 0; i <= STATS_INTERVAL; i += 1) h.tick();
  const body = JSON.parse(decodePage(h.platform.segment(STATS_PAGE) ?? '')!.body);
  expect(body.cpu.finish).toBeGreaterThan(0);
  expect(body.cpu.finish).toBeLessThan(body.cpu.avg);
  expect(body.memory.owners.map(([owner]: [string, number]) => owner)).toContain('kernel');
});
