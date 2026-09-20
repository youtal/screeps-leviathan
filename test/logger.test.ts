/**
 * 文件摘要：验证 core/logger 的等级、作用域、格式化、输出端口与邮件策略。
 *
 * 覆盖模块：createLogging（装配级工厂）与其 scope() 派生的 Logger。
 * 覆盖边界：
 * 1. 等级回退——未覆盖时跟随 setting 默认值，作用域可以逐字段显式开关；
 * 2. 作用域前缀——按等级着色，输出结构与 utils/console 的 dyeText 一致；
 * 3. 输出端口——默认端口调用 console.log / Game.notify，注入端口可完全替代；
 * 4. 邮件策略——装配级 off/error 与作用域级覆盖的组合，只有 error 等级发送；
 * 5. 失败隔离——端口抛错被吞掉，日志基础设施不得中断业务，也不依赖 Game/Memory。
 *
 * 运行方式与前提：普通 Jest（Node 环境）。用例通过注入端口收集文本，因此不需要
 * 真实的 Screeps 控制台；需要验证默认端口的用例会在用例内临时注入 Game 桩，
 * 并在 afterEach 清理，避免影响其它用例。
 */
import { createLogging } from '@/core/logger';
import { Color } from '@utils/console';

/** 去掉 dyeText 生成的 span 标签，便于断言纯文本内容。 */
const texts = (lines: string[]): string[] =>
  lines.map((line) => line.replace(/<[^>]+>/g, ''));

/**
 * 构造一个注入端口收集输出的工厂。
 * 返回值直接暴露两个数组，使断言可以区分"写控制台"与"发邮件"两条通道。
 */
const collect = (options: Parameters<typeof createLogging>[0] = {}) => {
  const lines: string[] = [];
  const notified: string[] = [];
  const factory = createLogging({
    ...options,
    output: {
      write: (line) => lines.push(line),
      notify: (line) => notified.push(line),
      ...options.output,
    },
  });
  return { factory, lines, notified };
};

describe('createLogging', () => {
  afterEach(() => {
    delete (global as any).Game;
    delete (global as any).Memory;
    jest.restoreAllMocks();
  });

  it('follows project defaults when neither assembly nor scope overrides levels', () => {
    const { factory, lines } = collect();
    const log = factory.scope('Scope');

    log.debug('d');
    log.info('i');
    log.success('s');
    log.warn('w');
    log.error('e');
    log.report('r');

    // 默认只有 warning/error/report 打开（见 setting.DEFAULT_LOG_CONFIG）。
    expect(texts(lines)).toEqual(['[Scope] w', '[Scope] e', '[Scope] r']);
  });

  it('lets a scope override single levels without disturbing the others', () => {
    const { factory, lines } = collect();
    const log = factory.scope('S', { levels: { report: false, debug: true } });

    log.report('r');
    log.debug('d');
    log.warn('w');

    expect(texts(lines)).toEqual(['[S] d', '[S] w']);
  });

  /** F7：isEnabled 与实际输出一致，热路径可据此跳过日志文本拼接。 */
  it('reports level availability consistently with what it emits', () => {
    const { factory } = collect();
    const log = factory.scope('S', { levels: { report: false, debug: true } });
    expect(log.isEnabled('report')).toBe(false);
    expect(log.isEnabled('debug')).toBe(true);
    expect(log.isEnabled('warn')).toBe(true);
  });

  it('formats the scope prefix with the level colour and bold style', () => {
    const { factory, lines } = collect();

    factory.scope('Room').warn('careful');
    factory.scope('').error('bare');

    expect(lines[0]).toContain('[Room] ');
    expect(lines[0]).toContain(Color.Orange);
    expect(lines[0]).toContain('font-weight: bold');
    expect(lines[0].endsWith('careful')).toBe(true);
    // 空作用域名退化为无前缀输出，方便独立测试或工具脚本使用。
    expect(texts([lines[1]])).toEqual(['bare']);
  });

  it('honours the assembly notify policy and its per-scope override', () => {
    const off = collect();
    off.factory.scope('A').error('boom');
    expect(off.notified).toEqual([]);

    const on = collect({ notify: 'error' });
    const log = on.factory.scope('B');
    log.warn('w');
    log.error('e');
    log.report('r');
    // 邮件只对 error 等级生效，且文本与控制台通道一致。
    expect(texts(on.notified)).toEqual(['[B] e']);

    const overridden = collect({ notify: 'error' });
    overridden.factory.scope('C', { notify: false }).error('quiet');
    expect(overridden.notified).toEqual([]);
  });

  it('treats the assembly notify policy as a hard cap for scopes', () => {
    // 装配为 off 时，作用域即使显式 true 也不能打开邮件（App 保留集中控制权）。
    const off = collect({ notify: 'off' });
    off.factory.scope('A', { notify: true }).error('bypass');
    expect(off.notified).toEqual([]);

    // 装配为 error 时，作用域 true 与省略都发送，false 关闭。
    const on = collect({ notify: 'error' });
    on.factory.scope('B', { notify: true }).error('explicit');
    on.factory.scope('B').error('follow');
    on.factory.scope('B', { notify: false }).error('closed');
    expect(texts(on.notified)).toEqual(['[B] explicit', '[B] follow']);
  });

  it('never lets a throwing output port break the caller', () => {
    const broken = createLogging({
      output: {
        write: () => {
          throw new Error('sink down');
        },
        notify: () => {
          throw new Error('mail down');
        },
      },
    });
    const log = broken.scope('S');

    expect(() => log.error('still runs')).not.toThrow();
  });

  it('rejects an invalid notify interval at assembly time', () => {
    expect(() => createLogging({ notifyInterval: 0 })).toThrow(
      'Invalid notify interval'
    );
  });

  it('works without Game, Memory or Profiler being available', () => {
    // Jest 的 node 环境默认没有 Screeps 全局；日志必须在观测设施缺席时仍可输出。
    expect((global as any).Game).toBeUndefined();

    const { factory, lines } = collect();
    factory.scope('S').error('standalone');

    expect(texts(lines)).toEqual(['[S] standalone']);
  });

  it('writes to console.log through the default port', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    createLogging().scope('Default').error('hello');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('hello');
  });

  it('calls Game.notify with the configured interval through the default port', () => {
    // 该用例走默认 write 端口，静默它以免测试输出被日志刷屏。
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const notify = jest.fn();
    (global as any).Game = { notify };

    createLogging({ notify: 'error', notifyInterval: 30 })
      .scope('Mail')
      .error('mail me');

    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain('mail me');
    expect(notify.mock.calls[0][1]).toBe(30);
  });
});
