/**
 * 文件摘要：app.ops 的测试：以 kernel 测试宿主驱动真实 kernel，经控制台全局对象调用 ops 命令。
 * 覆盖：status 的文本与单个模块明细；pause、resume、unset 与下一 tick 生效；生存层暂停与 Memory 不可用时的错误结果；
 * recover；log 修改默认开关与作用域覆盖、参数校验；kernel 销毁后 status 返回入口状态、其他命令返回桩结果（审计 LC-04）；
 * 被清单拒绝的模块在 status 与 status(id) 中显示原因，unset 能清除它的记录（审计 S-12、S-15）。
 */
import { type EntryStatus, createOps, formatEntry } from '@/app/ops';
import type { ModuleDefinition } from '@/contracts/module';
import { OFFLINE_RESULT } from '@/kernel/console';
import { kernelHarness } from '../kernel/lifecycle/harness';

/** 控制台中的 ops 命名空间。 */
type Ops = Record<string, (...args: unknown[]) => string>;

/**
 * @description 构造记录 plan 调用的模块。
 * @param id 模块 id。
 * @param calls 调用记录。
 * @param tier 层级。
 * @returns 模块定义。
 */
const mod = (id: string, calls: string[], tier: 'survival' | 'economy' = 'economy'): ModuleDefinition => ({
  id, tier, priority: 0, setup: () => ({ plan: () => { calls.push(id); } }),
});

const ENTRY: EntryStatus = { time: 42, cooldown: 0, crashes: 1, degraded: 0, paused: 0, lastFailure: { tick: 40, message: '正常循环抛错：坏了' } };

/**
 * @description 创建宿主并注册 ops 命令。
 * @param modules 模块清单。
 * @param memory 初始 Memory 文本，省略时为已初始化。
 * @returns 宿主与控制台中的 ops。
 */
const setup = (modules: ModuleDefinition[], memory?: string) => {
  const h = kernelHarness({ modules, memory });
  let entry = ENTRY;
  createOps({ kernel: h.kernel, logRoot: h.logRoot, entryStatus: () => entry });
  return { h, ops: () => h.globals.ops as Ops, setEntry: (e: EntryStatus) => { entry = e; } };
};

test('status：kernel 概要、每个模块一行与入口状态；status(id) 只显示该模块', () => {
  const { h, ops } = setup([mod('a', []), mod('s', [], 'survival')]);
  h.tick();
  const text = ops().status();
  expect(text.split('\n')[0]).toBe('tick 1，健康 ok，模式 AMBIGUOUS/medium，版本 test-release，Memory ready，B 25.00，R 2.50');
  expect(text).toContain('s（survival）运行，耗用 0.00，连续落选 0，实例 0（熔断 0）');
  expect(text).toContain('a（economy）运行');
  expect(text).toContain(formatEntry(ENTRY));
  expect(ops().status('a').split('\n')).toHaveLength(2);
  expect(ops().status('zz')).toBe('错误：未知模块 zz');
});

test('pause、resume、unset 下一 tick 生效；生存层与 Memory 不可用时返回错误文本', () => {
  const calls: string[] = [];
  const { h, ops } = setup([mod('a', calls), mod('s', calls, 'survival')]);
  h.tick();
  expect(ops().pause('a')).toBe('已暂停 a，下一 tick 生效');
  h.tick();
  expect(ops().resume('a')).toBe('已恢复 a，下一 tick 生效');
  h.tick();
  expect(ops().unset('a')).toBe('已清除 a 的运维覆盖，下一 tick 生效');
  expect(calls).toEqual(['s', 'a', 's', 's', 'a']);
  expect(ops().pause('s')).toContain('错误：s 是生存层模块');
  expect(ops().pause()).toBe('错误：模块 id 须为非空字符串');
  const empty = setup([mod('a', [])], '');
  empty.h.tick();
  expect(empty.ops().pause('a')).toContain('错误：Memory 不可用');
});

test('recover：清除熔断并说明下一 tick 起参与调度', () => {
  let failing = true;
  const flaky: ModuleDefinition = { id: 'f', tier: 'economy', priority: 0,
    setup: () => ({ plan: () => { if (failing) throw new Error('坏了'); } }) };
  const { h, ops } = setup([flaky]);
  h.tick(); h.tick(); h.tick();
  expect(ops().status()).toContain('f（economy）熔断');
  failing = false;
  expect(ops().recover('f')).toBe('已清除 f 的熔断，下一 tick 起参与调度');
  h.tick();
  expect(ops().status()).toContain('f（economy）运行');
});

test('log：修改默认开关或作用域覆盖；参数非法时返回错误文本', () => {
  const { h, ops } = setup([mod('a', [])]);
  h.tick();
  expect(ops().log('debug', true)).toBe('日志默认开关 debug = true');
  expect(h.logRoot.defaults().debug).toBe(true);
  expect(ops().log('info', false, 'a')).toBe('a 的日志 info = false');
  expect(h.kernel.ops.logger('a').enabled('info')).toBe(false);
  expect(ops().log('info', null, 'a')).toBe('a 的日志 info = 默认');
  expect(h.kernel.ops.logger('a').enabled('info')).toBe(true);
  expect(ops().log('verbose', true)).toContain('错误：level 须为');
  expect(ops().log('debug', 'yes')).toContain('错误：修改默认开关时 on 须为 true 或 false');
});

test('LC-04：kernel 销毁后 status 返回入口状态，其他命令返回桩结果', () => {
  const { h, ops, setEntry } = setup([mod('a', [])]);
  h.tick();
  h.kernel.dispose();
  expect(ops().status()).toBe(formatEntry(ENTRY));
  const cooling = { ...ENTRY, time: 50, cooldown: 37 };
  setEntry(cooling);
  expect(ops().status()).toContain('冷却剩余 37 tick');
  expect(ops().pause('a')).toBe(OFFLINE_RESULT);
});

test('审计 S-12、S-15：被清单拒绝的模块在 status 与 status(id) 中显示原因；unset 能清除它的记录', () => {
  const { h, ops } = setup([mod('a', []), { ...mod('orphan', []), requires: ['ghost'] }]);
  h.tick();
  expect(ops().status()).toContain('orphan（economy）初始化失败，耗用 -，连续落选 0，实例 0（熔断 0），未启动：依赖的模块 ghost 不存在');
  expect(ops().status('orphan')).toContain('未启动：依赖的模块 ghost 不存在');
  expect(ops().unset('orphan')).toBe('已清除 orphan 的运维覆盖，下一 tick 生效');
});
