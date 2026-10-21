/**
 * 文件摘要：kernel.console 的单元测试，以隔离的全局目标与记录型 Logger 驱动。
 * 覆盖：注册即安装；help 内容；命令与设置的调用；处理函数抛错时返回错误文本并记录日志；结果格式化与截断；
 * 与已有全局、命名空间内重名的冲突；销毁后换为桩对象、离线命令（审计 LC-04）；新实例覆盖桩对象；
 * 结果、错误文本、help 与设置的字符串值按 HTML 转义，换行保持原样（审计 S-23）。
 */
import type { Logger } from '@/contracts/log';
import { CONSOLE_RESULT_LIMIT, OFFLINE_RESULT, createConsole, formatResult } from '@/kernel/console';

/**
 * @description 创建隔离的全局目标与收集错误的日志。
 * @param globals 预置的全局属性。
 * @returns 目标、错误记录与 console 宿主。
 */
const setup = (globals: Record<string, unknown> = {}) => {
  const target: Record<string, unknown> = { ...globals };
  const errors: string[] = [];
  const logger = { error: (message: string) => { errors.push(String(message)); } } as unknown as Logger;
  return { target, errors, host: createConsole({ target, logger: () => logger }) };
};

/** 控制台中的命名空间对象。 */
type Space = Record<string, (...args: unknown[]) => string> & Record<string, unknown>;

test('注册即安装：命令、设置与自动的 help', () => {
  const { target, host } = setup();
  let dry = false;
  const reg = host.registry('boot');
  reg.command('assess', '只判定，不执行', (x?: unknown) => `判定 ${String(x ?? '')}`.trim());
  reg.setting('dryRun', '只观察判定结果；再次读取确认', () => dry, (v) => { if (typeof v !== 'boolean') throw new TypeError('须为布尔值'); dry = v; });
  const boot = target.boot as Space;
  expect(boot.assess()).toBe('判定');
  expect(boot.assess(3)).toBe('判定 3');
  boot.dryRun = true as never;
  expect([boot.dryRun, dry]).toEqual([true, true]);
  expect(boot.help()).toBe('boot.assess()  只判定，不执行\nboot.dryRun  只观察判定结果；再次读取确认');
});

test('处理函数抛错时返回错误文本并记录日志；设置写入被拒绝时忽略本次赋值', () => {
  const { target, errors, host } = setup();
  let value = 1;
  const reg = host.registry('ops');
  reg.command('boom', '抛错', () => { throw new Error('坏参数'); });
  reg.setting('level', '数值', () => value, (v) => { if (typeof v !== 'number') throw new TypeError('须为数值'); value = v; });
  const ops = target.ops as Space;
  expect(ops.boom()).toBe('错误：坏参数');
  ops.level = 'x' as never;
  expect(value).toBe(1);
  expect(errors).toEqual(['控制台命令 ops.boom 失败', '控制台设置 ops.level 写入被拒绝']);
});

test('结果格式化：字符串原样、undefined 为 ok、其他值 JSON 化、超长截断', () => {
  expect([formatResult('a'), formatResult(undefined), formatResult({ a: 1 }), formatResult(3)]).toEqual(['a', 'ok', '{"a":1}', '3']);
  const long = formatResult('x'.repeat(CONSOLE_RESULT_LIMIT + 5));
  expect(long.startsWith('x'.repeat(CONSOLE_RESULT_LIMIT))).toBe(true);
  expect(long).toContain(`共 ${CONSOLE_RESULT_LIMIT + 5} 字符`);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(formatResult(cyclic)).toBe('[object Object]');
});

test('已有的外来全局不被覆盖；命名空间内重名与非法名被拒绝', () => {
  const game = { time: 1 };
  const { target, errors, host } = setup({ Game: game });
  host.registry('Game').command('x', '', () => 'x');
  expect(target.Game).toBe(game);
  const reg = host.registry('m');
  reg.command('a', '', () => 'a');
  reg.command('a', '', () => 'b');
  reg.command('help', '', () => 'h');
  reg.command('Bad-name', '', () => 'h');
  expect((target.m as Space).a()).toBe('a');
  expect(errors).toEqual(['全局 Game 已被占用，控制台命名空间未安装', '控制台命令名 m.a 非法或重复，已忽略',
    '控制台命令名 m.help 非法或重复，已忽略', '控制台命令名 m.Bad-name 非法或重复，已忽略']);
});

test('LC-04：销毁后换为桩对象，离线命令仍可用；新实例覆盖桩对象', () => {
  const { target, host } = setup();
  let entry = 'cooldown 50';
  const reg = host.registry('ops');
  reg.command('status', '状态', () => 'kernel 状态');
  reg.command('pause', '暂停', () => 'paused');
  reg.setting('flag', '设置', () => 1, () => undefined);
  reg.offline('status', () => entry);
  host.dispose();
  const stub = target.ops as Space;
  expect(stub.status()).toBe('cooldown 50');
  entry = 'cooldown 49';
  expect(stub.status()).toBe('cooldown 49');
  expect(stub.pause()).toBe(OFFLINE_RESULT);
  expect(stub.flag).toBe(OFFLINE_RESULT);
  expect(stub.help()).toContain(OFFLINE_RESULT);
  reg.command('late', '销毁后注册', () => 'x');
  expect(stub.late).toBeUndefined();
  const next = createConsole({ target, logger: () => ({ error: () => undefined }) as unknown as Logger });
  next.registry('ops').command('status', '状态', () => '新 kernel');
  expect((target.ops as Space).status()).toBe('新 kernel');
});

test('离线命令只能登记给已注册的命令', () => {
  const { errors, host } = setup();
  host.registry('ops').offline('missing', () => 'x');
  expect(errors).toEqual(['离线命令 ops.missing 没有对应的命令']);
});

test('模块重新执行：上一轮执行或 0.1.16 留下的命名空间不算外来对象，被新命名空间取代；无标记的同名全局仍拒绝', () => {
  // 0.1.16 以普通 Symbol('kernel.console') 标记；模块在同一 global 中重新执行时，旧对象留在全局上。
  const legacy = Object.defineProperty({ status: () => '旧 kernel' }, Symbol('kernel.console'), { value: true });
  const other = Object.defineProperty({}, Symbol('other'), { value: true });
  const { target, errors, host } = setup({ ops: legacy, boot: other });
  host.registry('ops').command('status', '', () => '新 kernel');
  host.registry('boot').command('assess', '', () => 'x');
  expect((target.ops as Space).status()).toBe('新 kernel');
  expect(target.boot).toBe(other);
  expect(errors).toEqual(['全局 boot 已被占用，控制台命名空间未安装']);
  // 新命名空间以注册符号标记，再一轮模块执行同样能识别。
  const again = createConsole({ target, logger: () => ({ error: (m: string) => { errors.push(m); } }) as unknown as Logger });
  again.registry('ops').command('status', '', () => '第三轮');
  expect((target.ops as Space).status()).toBe('第三轮');
  expect(errors).toHaveLength(1);
});

test('审计 S-23：结果、错误文本、help 与设置的字符串值按 HTML 转义，换行保持原样', () => {
  const { target, host } = setup();
  const reg = host.registry('ops');
  reg.command('show', 'ops.show(key)：<模块 id>:<实例键> & 其他', () => 'a<b>&c\n第二行');
  reg.command('boom', '抛错', () => { throw new Error('未知进程 <x>'); });
  reg.setting('name', '名称', () => '<i>', () => undefined);
  const ops = target.ops as Space;
  expect(ops.show()).toBe('a&lt;b&gt;&amp;c\n第二行');
  expect(ops.boom()).toBe('错误：未知进程 &lt;x&gt;');
  expect(ops.help()).toBe('ops.show()  ops.show(key)：&lt;模块 id&gt;:&lt;实例键&gt; &amp; 其他\nops.boom()  抛错\nops.name  名称');
  expect(ops.name).toBe('&lt;i&gt;');
});
