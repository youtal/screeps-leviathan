/**
 * 文件摘要：kernel.process 清单规划（src/kernel/process/index.ts）的单元测试。
 * 覆盖稳定拓扑排序（依赖、层级、priority、id）、optional 只影响顺序，以及各类拒绝条件与依赖传播：
 * 空 id、保留 id、重复 id、未知依赖、requires 层级更低的模块、依赖环，且其余模块照常启动。
 */
import type { Tier } from '@/contracts/cpu';
import type { ModuleDefinition } from '@/contracts/module';
import { planModules } from '@/kernel/process';

/**
 * @description 构造测试用模块定义。
 * @param id 模块 id。
 * @param tier 层级，默认 economy。
 * @param priority 同层顺序，默认 0。
 * @param deps 依赖。
 * @param deps.requires 硬依赖。
 * @param deps.optional 软依赖。
 * @returns 模块定义；setup 返回空钩子。
 */
const mod = (id: string, tier: Tier = 'economy', priority = 0, deps: { requires?: string[]; optional?: string[] } = {}): ModuleDefinition =>
  ({ id, tier, priority, ...deps, setup: () => ({}) });

const ids = (plan: ReturnType<typeof planModules>) => plan.order.map((m) => m.id);

test('无依赖时按层级、priority、id 排序', () => {
  const plan = planModules([mod('b', 'economy', 1), mod('a', 'economy', 1), mod('z', 'survival', 9), mod('p', 'planning'), mod('c', 'economy', 0)]);
  expect(ids(plan)).toEqual(['z', 'c', 'a', 'b', 'p']);
  expect(plan.rejected.size).toBe(0);
});

test('依赖先于依赖者；optional 只影响顺序，指向的模块被拒绝时不连带拒绝', () => {
  const plan = planModules([
    mod('user', 'survival', 0, { requires: ['base'], optional: ['extra'] }),
    mod('base', 'survival', 5),
    mod('extra', 'survival', 9),
  ]);
  expect(ids(plan)).toEqual(['base', 'extra', 'user']);
  const isolated = planModules([mod('user', 'economy', 0, { optional: ['dup'] }), mod('dup'), mod('dup')]);
  expect(ids(isolated)).toEqual(['user']);
  expect(isolated.rejected.get('dup')).toContain('重复');
});

test.each([
  ['空 id', [mod('')], '（空 id）', 'id 为空'],
  ['保留 id', [mod('core')], 'core', '保留'],
  ['重复 id', [mod('x'), mod('x')], 'x', '重复'],
  ['未知依赖', [mod('x', 'economy', 0, { requires: ['ghost'] })], 'x', '不存在'],
  ['requires 层级更低的模块', [mod('x', 'survival', 0, { requires: ['y'] }), mod('y', 'economy')], 'x', '层级更低'],
])('%s：拒绝该模块并给出原因', (_label, modules, id, reason) => {
  expect(planModules(modules).rejected.get(id)).toContain(reason);
});

test('只隔离问题模块及其依赖者，其余照常启动；依赖环上的模块与依赖它们的模块被拒绝', () => {
  const plan = planModules([
    mod('ok', 'survival'),
    mod('bad', 'economy', 0, { requires: ['ghost'] }),
    mod('child', 'economy', 1, { requires: ['bad'] }),
    mod('grandchild', 'maintenance', 0, { requires: ['child'] }),
    mod('a', 'planning', 0, { requires: ['b'] }),
    mod('b', 'planning', 0, { requires: ['a'] }),
    mod('onCycle', 'planning', 1, { requires: ['a'] }),
    mod('fine', 'planning', 2, { optional: ['ok'] }),
  ]);
  expect(ids(plan)).toEqual(['ok', 'fine']);
  expect([...plan.rejected.keys()].sort()).toEqual(['a', 'b', 'bad', 'child', 'grandchild', 'onCycle']);
  expect(plan.rejected.get('child')).toContain('bad');
  expect(plan.rejected.get('a')).toContain('依赖环');
});
