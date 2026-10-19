/**
 * 文件摘要：kernel.lifecycle（src/kernel/lifecycle/index.ts）的单元测试，以 Memory 平台替身与假 GamePort 驱动。
 * 覆盖：空存储只运行 boot、就绪后 setup 一次、阶段顺序与模块顺序、熔断与依赖暂停、setup 失败不重试、
 * 新增实例从下一阶段参与调度、boot 失败跳过业务钩子并计为 degraded、清单拒绝的隔离、Memory 加载失败、
 * 生存层模块不可用时 degraded、dispose 的清理与错误隔离、上下文的日志与 Memory 能力。
 */
import type { PhaseHooks } from '@/contracts/context';
import type { Tier } from '@/contracts/cpu';
import type { ModuleDefinition } from '@/contracts/module';
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
