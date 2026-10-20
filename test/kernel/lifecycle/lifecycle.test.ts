/**
 * 文件摘要：kernel.lifecycle（src/kernel/lifecycle/index.ts）的单元测试，以 Memory 平台替身与假 GamePort 驱动。
 * 覆盖：空存储只运行 boot、就绪后 setup 一次、阶段顺序与模块顺序、熔断与依赖暂停、setup 失败不重试、
 * 新增实例从下一阶段参与调度、boot 失败跳过业务钩子并计为 degraded、清单拒绝的隔离、Memory 加载失败、
 * 生存层模块不可用时 degraded、dispose 的清理与错误隔离、上下文的日志与 Memory 能力；
 * 维护层实例按自身相位运行（审计 PA-01）、进程表的 remove/has 与 instance（PA-09）、tick 倒退时跳过并计为 degraded（PA-16）、
 * 提交持续失败只记录一次（PA-17）、实例计时开关（PA-04）、boot 上下文的收窄与清理（PA-05）。
 */
import type { PhaseHooks } from '@/contracts/context';
import type { Tier } from '@/contracts/cpu';
import type { ModuleDefinition } from '@/contracts/module';
import { ModuleRuntime } from '@/kernel/context';
import { MAINTENANCE_PERIOD } from '@/kernel/cpu';
import { hashString } from '@/lib/hash';
import { kernelHarness } from './harness';

/**
 * @description 构造记录调用顺序的模块。
 * @param id 模块 id。
 * @param calls 调用记录。
 * @param options 可选项。
 * @param options.tier 层级，默认 economy。
 * @param options.priority 同层顺序，默认 0。
 * @param options.requires 硬依赖。
 * @param options.hooks 覆盖默认钩子。
 * @returns 模块定义。
 */
const recorder = (id: string, calls: string[], options: { tier?: Tier; priority?: number; requires?: string[]; hooks?: PhaseHooks } = {}): ModuleDefinition => ({
  id, tier: options.tier ?? 'economy', priority: options.priority ?? 0, requires: options.requires,
  setup: () => {
    calls.push(`${id}.setup`);
    return options.hooks ?? { plan: () => { calls.push(`${id}.plan`); }, act: () => { calls.push(`${id}.act`); } };
  },
});

test('空存储时只运行 boot：不 setup、不运行业务钩子、不提交', () => {
  const calls: string[] = [];
  const h = kernelHarness({ modules: [recorder('a', calls)], memory: '', boot: { setup: () => ({ boot: () => { calls.push('boot'); } }) } });
  expect(h.tick()).toBe('ok');
  expect(calls).toEqual(['boot']);
  expect(h.platform.memory).toBe('');
});

test('Memory 就绪后只 setup 一次；阶段按 plan → act，模块按层级与 priority', () => {
  const calls: string[] = [];
  const h = kernelHarness({ modules: [recorder('late', calls, { tier: 'planning' }), recorder('first', calls, { tier: 'survival' }), recorder('mid', calls)] });
  h.tick();
  h.tick();
  expect(calls).toEqual([
    'first.setup', 'mid.setup', 'late.setup',
    'first.plan', 'mid.plan', 'late.plan', 'first.act', 'mid.act', 'late.act',
    'first.plan', 'mid.plan', 'late.plan', 'first.act', 'mid.act', 'late.act',
  ]);
});

test('钩子连续失败 3 次熔断，只记录到熔断为止；依赖它的模块一同暂停；成功一次即归零', () => {
  const calls: string[] = [];
  let failing = true;
  const flaky: ModuleDefinition = { id: 'flaky', tier: 'economy', priority: 0,
    setup: () => ({ plan: () => { if (failing) throw new Error('坏了'); calls.push('flaky.plan'); } }) };
  const h = kernelHarness({ modules: [flaky, recorder('child', calls, { requires: ['flaky'], priority: 1 })] });
  h.tick();
  h.tick();
  failing = false;
  h.tick();
  failing = true;
  h.tick(); h.tick(); h.tick(); h.tick();
  const errors = h.lines.filter((l) => l.includes('flaky.plan'));
  expect(errors).toHaveLength(5);
  expect(errors[4]).toContain('已熔断');
  expect(calls.filter((c) => c === 'child.plan')).toHaveLength(5);
});

test('setup 失败进入初始化失败，本 global 不再重试；不影响其他模块', () => {
  const calls: string[] = [];
  let attempts = 0;
  const broken: ModuleDefinition = { id: 'broken', tier: 'economy', priority: 0, setup: () => { attempts += 1; throw new Error('初始化失败'); } };
  const h = kernelHarness({ modules: [broken, recorder('ok', calls, { priority: 1 })] });
  h.tick(); h.tick();
  expect(attempts).toBe(1);
  expect(calls.filter((c) => c === 'ok.plan')).toHaveLength(2);
});

test('新增实例从下一阶段开始参与调度；实例钩子失败只影响该实例', () => {
  const calls: string[] = [];
  const parent: ModuleDefinition = {
    id: 'parent', tier: 'economy', priority: 0,
    setup: (ctx) => ({
      plan: () => {
        ctx.processes.add('s1', (ictx) => ({ plan: () => { calls.push(`${ictx.key}.plan`); }, act: () => { calls.push(`${ictx.key}.act`); } }));
        ctx.processes.add('bad', () => ({ act: () => { throw new Error('实例坏了'); } }));
      },
    }),
  };
  const h = kernelHarness({ modules: [parent] });
  h.tick();
  h.tick();
  expect(calls).toEqual(['parent:s1.act', 'parent:s1.plan', 'parent:s1.act']);
  expect(h.lines.some((l) => l.includes('parent:bad.act'))).toBe(true);
});

test('boot 失败时跳过 setup 与业务钩子并计为 degraded，仍提交；只在连续失败开始时记录一次', () => {
  const calls: string[] = [];
  let fail = true;
  const h = kernelHarness({ modules: [recorder('a', calls)], boot: { setup: () => ({ boot: () => { if (fail) throw new Error('判定失败'); } }) } });
  expect(h.tick()).toBe('degraded');
  expect(h.tick()).toBe('degraded');
  expect(calls).toEqual([]);
  expect(h.lines.filter((l) => l.includes('boot 失败'))).toHaveLength(1);
  fail = false;
  expect(h.tick()).toBe('ok');
  expect(calls).toEqual(['a.setup', 'a.plan', 'a.act']);
  expect(h.lines.some((l) => l.includes('boot 恢复'))).toBe(true);
  // 模块已 setup 之后 boot 再次失败：本 tick 同样跳过业务钩子。
  fail = true;
  expect(h.tick()).toBe('degraded');
  expect(calls).toEqual(['a.setup', 'a.plan', 'a.act']);
});

test('清单被拒绝的模块不启动并记录原因，其余模块照常运行；被拒绝的是生存层模块时 degraded', () => {
  const calls: string[] = [];
  const h = kernelHarness({ modules: [recorder('ok', calls), recorder('orphan', calls, { requires: ['ghost'] })] });
  expect(h.tick()).toBe('ok');
  expect(calls).toEqual(['ok.setup', 'ok.plan', 'ok.act']);
  expect(h.lines.some((l) => l.includes('模块 orphan 未启动'))).toBe(true);
  const h2 = kernelHarness({ modules: [recorder('guard', [], { tier: 'survival', requires: ['ghost'] })] });
  expect(h2.tick()).toBe('degraded');
});

test('生存层模块熔断后 degraded', () => {
  const bad: ModuleDefinition = { id: 'tower', tier: 'survival', priority: 0, setup: () => ({ act: () => { throw new Error('x'); } }) };
  const h = kernelHarness({ modules: [bad] });
  expect([h.tick(), h.tick(), h.tick(), h.tick()]).toEqual(['ok', 'ok', 'degraded', 'degraded']);
});

test('Memory 加载失败计为 degraded，只记录一次，普通模块不 setup', () => {
  const calls: string[] = [];
  const h = kernelHarness({ modules: [recorder('a', calls)], memory: '{bad' });
  expect([h.tick(), h.tick()]).toEqual(['degraded', 'degraded']);
  expect(calls).toEqual([]);
  expect(h.lines.filter((l) => l.includes('Memory 不可用'))).toHaveLength(1);
});

test('上下文：日志作用域为模块 id，分区可读写并在 tick 末提交', () => {
  const store: ModuleDefinition = {
    id: 'store', tier: 'economy', priority: 0,
    setup: (ctx) => {
      const data = ctx.memory.partition('cfg', { version: 1, initialize: () => ({ n: 0 }), migrate: () => ({ n: 0 }) });
      return { plan: () => { data.set(['n'], (data.get(['n']) ?? 0) + 1); ctx.log.info(`n=${data.get(['n'])}`); } };
    },
  };
  const h = kernelHarness({ modules: [store] });
  h.tick(); h.tick();
  expect(h.lines).toEqual(['[1] INFO store: n=1', '[2] INFO store: n=2']);
  expect(JSON.parse(h.platform.memory).leviathan.part.store.cfg.data.n).toBe(2);
});

test('dispose 调用实例与模块的清理函数，单个清理抛错不影响其他；之后 tick 抛错', () => {
  const calls: string[] = [];
  const mod: ModuleDefinition = {
    id: 'm', tier: 'economy', priority: 0,
    setup: (ctx) => {
      ctx.onDispose(() => { throw new Error('清理失败'); });
      ctx.onDispose(() => { calls.push('module'); });
      ctx.processes.add('i', () => ({ dispose: () => { calls.push('instance'); } }));
      return {};
    },
  };
  const h = kernelHarness({ modules: [mod] });
  h.tick();
  h.kernel.dispose();
  h.kernel.dispose();
  expect(calls).toEqual(['instance', 'module']);
  expect(() => h.kernel.tick()).toThrow('已销毁');
});

test('PA-01：维护层的模块与实例按各自的进程键错峰运行，模块空闲的 tick 实例照常运行；模块暂停时实例一同跳过', () => {
  // 选一个与模块相位不同的实例键，保证两者错峰。
  const key = ['b', 'c', 'd', 'e'].find((k) => hashString(`m:${k}`) % MAINTENANCE_PERIOD !== hashString('m') % MAINTENANCE_PERIOD)!;
  const calls: string[] = [];
  /**
   * @description 构造带一个动态实例的维护层模块。
   * @param startPaused 是否默认暂停。
   * @returns 模块定义。
   */
  const maintenance = (startPaused: boolean): ModuleDefinition => ({
    id: 'm', tier: 'maintenance', priority: 0, startPaused,
    setup: (ctx) => {
      ctx.processes.add(key, () => ({ plan: () => { calls.push('instance'); } }));
      return { plan: () => { calls.push('module'); } };
    },
  });
  const h = kernelHarness({ modules: [maintenance(false)] });
  for (let i = 0; i < 4 * MAINTENANCE_PERIOD; i += 1) h.tick();
  expect(calls.filter((c) => c === 'module')).toHaveLength(4);
  expect(calls.filter((c) => c === 'instance')).toHaveLength(4);
  calls.length = 0;
  const paused = kernelHarness({ modules: [maintenance(true)] });
  for (let i = 0; i < 2 * MAINTENANCE_PERIOD; i += 1) paused.tick();
  expect(calls).toEqual([]);
});

test('PA-09：阶段中移除实例立即调用 dispose 并停止调度，has 随之变化；instance(key) 缓存同一上下文，键为完整进程键', () => {
  const calls: string[] = [];
  const seen: { hasA?: boolean; same?: boolean; key?: string } = {};
  const mod: ModuleDefinition = {
    id: 'm', tier: 'economy', priority: 0,
    setup: (ctx) => {
      ctx.processes.add('a', () => ({
        plan: () => { calls.push('a.plan'); }, act: () => { calls.push('a.act'); }, dispose: () => { calls.push('a.dispose'); },
      }));
      ctx.processes.add('b', () => ({
        plan: () => { calls.push('b.plan'); ctx.processes.remove('a'); seen.hasA = ctx.processes.has('a'); },
        act: () => { calls.push('b.act'); },
      }));
      seen.same = ctx.instance('b') === ctx.instance('b');
      seen.key = ctx.instance('b').key;
      return {};
    },
  };
  const h = kernelHarness({ modules: [mod] });
  h.tick();
  expect(calls).toEqual(['a.plan', 'b.plan', 'a.dispose', 'b.act']);
  expect(seen).toEqual({ hasA: false, same: true, key: 'm:b' });
});

test('PA-17：Memory 提交持续失败（超过体积上限）时只在开始时记录一次，恢复时记录一次', () => {
  let size = 2 * 1024 * 1024 + 1;
  const mod: ModuleDefinition = { id: 'big', tier: 'economy', priority: 0,
    setup: (ctx) => {
      const data = ctx.memory.partition('p', { version: 1, initialize: () => ({ s: '' }), migrate: () => ({ s: '' }) });
      return { act: () => { data.set(['s'], 'x'.repeat(size)); } };
    } };
  const h = kernelHarness({ modules: [mod] });
  for (let i = 0; i < 5; i += 1) h.tick();
  size = 10;
  h.tick();
  expect(h.lines.filter((l) => l.includes('Memory 提交失败'))).toHaveLength(1);
  expect(h.lines.filter((l) => l.includes('Memory 提交恢复（此前连续失败 5 次）'))).toHaveLength(1);
  expect(JSON.parse(h.platform.memory).leviathan.part.big.p.data.s).toBe('x'.repeat(10));
});

test('PA-16：同一 global 内 tick 倒退时跳过业务钩子、维护与提交并计为 degraded，时间追上后恢复', () => {
  let t = 0;
  const acts: number[] = [];
  const mod: ModuleDefinition = { id: 'w', tier: 'survival', priority: 0,
    setup: (ctx) => {
      const data = ctx.memory.partition('p', { version: 1, initialize: () => ({ n: 0 }), migrate: () => ({ n: 0 }) });
      return { act: () => { data.set(['n'], t); acts.push(t); } };
    } };
  const h = kernelHarness({ modules: [mod], game: { time: () => t } });
  const health: (string | undefined)[] = [];
  for (const time of [100, 101, 102, 50, 51, 103]) {
    t = time;
    health.push(h.tick());
  }
  expect(health).toEqual(['ok', 'ok', 'ok', 'degraded', 'degraded', 'ok']);
  expect(acts).toEqual([100, 101, 102, 103]);
  expect(JSON.parse(h.platform.memory).leviathan.part.w.p.data.n).toBe(103);
  expect(h.lines.filter((l) => l.includes('Memory 本 tick 无法开始'))).toHaveLength(1);
  expect(h.lines.filter((l) => l.includes('Memory 恢复可用'))).toHaveLength(1);
  expect(h.lines.some((l) => l.includes('Memory 提交失败'))).toBe(false);
});

test('PA-04：开启实例计时时实例钩子按进程键计时，默认只按模块计时', () => {
  /**
   * @description 运行带一个实例的模块两个 tick，返回计时器中的标签。
   * @param profileInstances 是否开启实例计时。
   * @returns 计时标签。
   */
  const labels = (profileInstances: boolean): string[] => {
    const mod: ModuleDefinition = { id: 'm', tier: 'economy', priority: 0,
      setup: (ctx) => { ctx.processes.add('i', () => ({ plan: () => undefined })); return { plan: () => undefined }; } };
    const h = kernelHarness({ modules: [mod], profileInstances });
    h.tick(); h.tick();
    return h.profiler.snapshot().map((e) => e.label);
  };
  expect(labels(true)).toEqual(expect.arrayContaining(['m.plan', 'm:i.plan']));
  expect(labels(false)).not.toContain('m:i.plan');
  // 实例记录直接持有计时器：执行钩子时不再按进程键查找实例上下文。
  const mod: ModuleDefinition = { id: 'm', tier: 'economy', priority: 0,
    setup: (ctx) => { ctx.processes.add('i', () => ({ plan: () => undefined, act: () => undefined })); return {}; } };
  const h = kernelHarness({ modules: [mod], profileInstances: true });
  h.tick();
  const lookups = jest.spyOn(ModuleRuntime.prototype, 'instance');
  try {
    for (let i = 0; i < 5; i += 1) h.tick();
    expect(lookups).not.toHaveBeenCalled();
  } finally { lookups.mockRestore(); }
});

test('PA-05：dispose 调用 boot 经 onDispose 登记的清理函数；boot 上下文不提供进程表与实例上下文', () => {
  const disposed: string[] = [];
  const seen: { processes?: unknown; instance?: unknown } = {};
  const h = kernelHarness({ modules: [], boot: { setup: (ctx) => {
    ctx.onDispose(() => { disposed.push('boot'); });
    const raw = ctx as unknown as { processes?: unknown; instance?: unknown };
    seen.processes = raw.processes;
    seen.instance = raw.instance;
    return { boot: () => undefined };
  } } });
  h.tick();
  h.kernel.dispose();
  expect(disposed).toEqual(['boot']);
  expect(seen).toEqual({ processes: undefined, instance: undefined });
});
