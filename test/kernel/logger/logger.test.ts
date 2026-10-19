/**
 * 文件摘要：kernel.logger（src/kernel/logger/index.ts）的单元测试。
 * 覆盖输出格式与五个级别、默认开关必须完整、双层开关（默认值、作用域覆盖、取消覆盖、实例继承模块覆盖、
 * 修改默认值）、关闭时正文函数不求值、error 附带格式化文本、上色与转义，以及各种失败不向调用方传播。
 */
import type { LogLevel, LogLevelSwitches } from '../../../src/contracts/log';
import { LEVEL_COLORS, createLogRoot } from '../../../src/kernel/logger';

const ALL_ON: LogLevelSwitches = { debug: true, info: true, success: true, warn: true, error: true };

/**
 * @description 创建带记录输出端的日志根对象。
 * @param options 可选项。
 * @param options.levels 默认开关，默认全部打开。
 * @param options.color 是否上色，默认 false。
 * @param options.format 错误格式化函数，默认在文本前加"格式化:"。
 * @returns 日志根对象与已输出的行。
 */
const setup = (options: { levels?: LogLevelSwitches; color?: boolean; format?: (error: unknown) => string } = {}) => {
  const lines: string[] = [];
  const root = createLogRoot({
    sink: (line) => lines.push(line), time: () => 42, levels: options.levels ?? ALL_ON,
    format: options.format ?? ((e) => `格式化:${String(e)}`), color: options.color,
  });
  return { root, lines };
};

test('五个级别的输出格式为 [tick] 级别 作用域: 正文', () => {
  const { root, lines } = setup();
  const log = root.scope('mining');
  log.debug('d');
  log.info('i');
  log.success('RCL 升到 4');
  log.warn('w');
  log.error('e');
  expect(lines).toEqual([
    '[42] DEBUG mining: d', '[42] INFO mining: i', '[42] SUCCESS mining: RCL 升到 4', '[42] WARN mining: w', '[42] ERROR mining: e',
  ]);
});

test('初始化必须为每个级别给出默认开关', () => {
  const partial = { debug: false, info: true, warn: true, error: true } as unknown as LogLevelSwitches;
  expect(() => createLogRoot({ sink: () => undefined, time: () => 0, format: String, levels: partial })).toThrow('success');
});

test('第一层：按默认开关输出；关闭的级别不对函数正文求值', () => {
  const { root, lines } = setup({ levels: { ...ALL_ON, debug: false, info: false } });
  const log = root.scope('s');
  const expensive = jest.fn(() => '昂贵');
  log.debug(expensive);
  log.info(expensive);
  log.success(() => '成交');
  expect(expensive).not.toHaveBeenCalled();
  expect(lines).toEqual(['[42] SUCCESS s: 成交']);
  expect(log.enabled('debug')).toBe(false);
});

test('第二层：作用域覆盖默认值，取消覆盖后恢复默认值；只影响本作用域', () => {
  const { root, lines } = setup({ levels: { ...ALL_ON, debug: false } });
  const mining = root.scope('mining');
  const other = root.scope('other');
  mining.configLevel({ debug: true, warn: false });
  mining.debug('开');
  mining.warn('关');
  other.debug('仍关');
  other.warn('仍开');
  mining.configLevel({ debug: undefined });
  mining.debug('恢复默认');
  expect(lines).toEqual(['[42] DEBUG mining: 开', '[42] WARN other: 仍开']);
});

test('实例作用域继承所属模块的覆盖值，也可以再覆盖', () => {
  const { root, lines } = setup({ levels: { ...ALL_ON, debug: false } });
  const module = root.scope('mining');
  const instance = root.scope('mining:W1N1:s1', module);
  module.configLevel({ debug: true });
  instance.debug('继承');
  instance.configLevel({ debug: false });
  instance.debug('自己关闭');
  module.debug('模块仍开');
  expect(lines).toEqual(['[42] DEBUG mining:W1N1:s1: 继承', '[42] DEBUG mining: 模块仍开']);
});

test('修改默认值对未覆盖的作用域立即生效；defaults 返回副本', () => {
  const { root, lines } = setup({ levels: { ...ALL_ON, success: false } });
  const plain = root.scope('a');
  const pinned = root.scope('b');
  pinned.configLevel({ success: false });
  root.setDefault('success', true);
  plain.success('开');
  pinned.success('仍关');
  const copy = root.defaults() as Record<LogLevel, boolean>;
  copy.success = false;
  expect(root.defaults().success).toBe(true);
  expect(lines).toEqual(['[42] SUCCESS a: 开']);
});

test('configLevel 一次配置多个级别，未列出的保持原状；未知级别或非布尔值报错且不生效', () => {
  const { root } = setup({ levels: { ...ALL_ON, debug: false } });
  const log = root.scope('s');
  log.configLevel({ debug: true, info: false, success: false });
  expect([log.enabled('debug'), log.enabled('info'), log.enabled('success'), log.enabled('warn')]).toEqual([true, false, false, true]);
  expect(() => log.configLevel({ verbose: true } as never)).toThrow('verbose');
  expect(() => log.configLevel({ debug: false, warn: 'no' } as never)).toThrow('warn');
  expect(log.enabled('debug')).toBe(true);
});

test('父作用域必须来自同一根对象', () => {
  const { root } = setup();
  const foreign = setup().root.scope('x');
  expect(() => root.scope('y', foreign)).toThrow('父作用域');
});

test('error 给出抛出值时另起一行附上格式化文本', () => {
  const { root, lines } = setup();
  root.scope('kernel').error('钩子失败', new Error('boom'));
  expect(lines).toEqual(['[42] ERROR kernel: 钩子失败\n格式化:Error: boom']);
});

test('输出端、格式化函数与正文函数抛错都不向调用方传播', () => {
  const broken = createLogRoot({ sink: () => { throw new Error('控制台不可用'); }, time: () => 1, format: String, levels: ALL_ON });
  expect(() => broken.scope('s').error('x', new Error('y'))).not.toThrow();
  const { root, lines } = setup({ format: () => { throw new Error('映射失败'); } });
  const log = root.scope('s');
  log.error('失败', 'raw');
  log.info(() => { throw 'bad'; });
  expect(lines).toEqual(['[42] ERROR s: 失败\nraw', '[42] INFO s: （日志正文求值失败）bad']);
});

describe('上色', () => {
  test('各级别前缀颜色：debug 天青、info 灰、success 绿、warn 橙、error 红', () => {
    const { root, lines } = setup({ color: true });
    const log = root.scope('s');
    log.debug('d');
    log.info('i');
    log.success('s');
    log.warn('w');
    log.error('e');
    expect(lines).toEqual([
      `<span style="color:${LEVEL_COLORS.debug}">[42] DEBUG</span> s: d`,
      `<span style="color:${LEVEL_COLORS.info}">[42] INFO</span> s: i`,
      `<span style="color:${LEVEL_COLORS.success}">[42] SUCCESS</span> s: s`,
      `<span style="color:${LEVEL_COLORS.warn}">[42] WARN</span> s: w`,
      `<span style="color:${LEVEL_COLORS.error}">[42] ERROR</span> s: e`,
    ]);
    expect(LEVEL_COLORS).toEqual({ debug: '#00f7f6', info: '#95a5a6', success: '#2ecc71', warn: '#f39c12', error: '#e74c3c' });
  });

  test('转义作用域与正文中的 &、<、>，堆栈中的 <anonymous> 原样显示；正文换行改为 <br>', () => {
    const { root, lines } = setup({ color: true, format: (e) => String((e as Error).stack) });
    const error = Object.assign(new Error('x'), { stack: 'Error: x\n    at <anonymous>' });
    root.scope('a<b>').error('1 < 2 & 3', error);
    expect(lines).toEqual([`<span style="color:${LEVEL_COLORS.error}">[42] ERROR</span> a&lt;b&gt;: 1 &lt; 2 &amp; 3<br>Error: x<br>    at &lt;anonymous&gt;`]);
  });

  test('未开启上色时输出纯文本，不转义', () => {
    const { root, lines } = setup();
    root.scope('a<b>').info('1 < 2');
    expect(lines).toEqual(['[42] INFO a<b>: 1 < 2']);
  });
});

test('作用域 Logger 是扁平对象：方法在原型上共享，自身只保存数据字段（架构 12.1）', () => {
  const { root } = setup();
  const a = root.scope('a');
  const b = root.scope('b', a);
  const ownFunctions = Object.values(a).filter((value) => typeof value === 'function');
  expect(ownFunctions).toEqual([]);
  expect(a.info).toBe(b.info);
});
