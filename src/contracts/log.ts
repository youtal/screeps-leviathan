/**
 * 文件摘要：日志与计时的注入接口（contracts 层，设计见 docs/design/contracts/README.md 第 4 节）。
 *
 * kernel.logger 与 kernel.profiler 实现这些接口，并通过上下文注入给模块；作用域与计时标签前缀由上下文绑定。
 * 本文件只含类型声明，没有运行时代码。
 */

/**
 * 日志级别：
 * - debug：调试细节；
 * - info：一般运行信息；
 * - success：游戏内关键状态转移成功，例如 RCL 升级、订单创建或成交、殖民地扩张成功；
 * - warn：可恢复的异常情况；
 * - error：错误。
 */
export type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

/** 日志正文：文本，或返回文本的函数；函数形式只在该级别开启时求值，避免热路径上无谓地拼接字符串。 */
export type LogMessage = string | (() => string);

/** 每个级别的开关：{ [级别]: 是否输出 }，必须覆盖全部级别。 */
export type LogLevelSwitches = Readonly<Record<LogLevel, boolean>>;

/**
 * 作用域日志。作用域为模块 ID 或进程键，由上下文绑定。
 * 每个级别有两层开关：日志根对象初始化时给出的默认值，以及本作用域的覆盖值；实际开关取覆盖值，没有覆盖时取默认值。
 * 实例作用域继承所属模块作用域的覆盖值。
 */
export interface Logger {
  /**
   * @description 输出调试日志；该级别关闭时直接丢弃，函数正文不求值。
   * @param message 日志正文或返回正文的函数。
   * @returns 无返回值。
   */
  debug(message: LogMessage): void;
  /**
   * @description 输出一般信息日志；该级别关闭时直接丢弃。
   * @param message 日志正文或返回正文的函数。
   * @returns 无返回值。
   */
  info(message: LogMessage): void;
  /**
   * @description 汇报游戏内关键状态转移成功；该级别关闭时直接丢弃。
   * @param message 日志正文或返回正文的函数。
   * @returns 无返回值。
   */
  success(message: LogMessage): void;
  /**
   * @description 输出警告日志，用于可恢复的异常情况；该级别关闭时直接丢弃。
   * @param message 日志正文或返回正文的函数。
   * @returns 无返回值。
   */
  warn(message: LogMessage): void;
  /**
   * @description 输出错误日志；该级别关闭时直接丢弃。
   * @param message 日志正文或返回正文的函数。
   * @param error 可选的异常对象；经 errorMapper 规范化并映射到源码位置。
   * @returns 无返回值。
   */
  error(message: LogMessage, error?: unknown): void;
  /**
   * @description 一次覆盖本作用域的一个或多个级别；未列出的级别保持原状。实例作用域未覆盖时继承此处的值。
   * 覆盖只存于 heap，global reset 后由模块在 setup 中重新设置。
   * @param levels { [级别]: true 打开 | false 关闭 | undefined 取消覆盖、恢复默认值 }。
   * @returns 无返回值。
   * @example ctx.log.configLevel({ debug: true, info: false });
   */
  configLevel(levels: Readonly<Partial<Record<LogLevel, boolean | undefined>>>): void;
  /**
   * @description 查询本作用域某个级别当前是否会输出。
   * @param level 日志级别。
   * @returns 会输出时为 true。
   */
  enabled(level: LogLevel): boolean;
}

/**
 * 计时。用 begin/end 两次调用代替 `measure(op, fn)`，避免热路径每次创建闭包。
 * 计时标签为 `<作用域>.<op>`；op 必须取自有限集合，不得包含 tick、creep 名等无界字段。
 */
export interface Measure {
  /**
   * @description 开始一次计时。
   * @returns 开始时的 CPU 读数，原样交给 end。
   */
  begin(): number;
  /**
   * @description 结束一次计时，把耗用计入标签 `<作用域>.<op>`。
   * @param op 操作名，取自有限集合，不得包含 tick、creep 名等无界字段。
   * @param start begin 返回的开始读数。
   * @returns 无返回值。
   */
  end(op: string, start: number): void;
}
