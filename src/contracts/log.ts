/**
 * 文件摘要：日志与计时的注入接口（contracts 层，设计见 docs/design/contracts/README.md 第 4 节）。
 *
 * kernel.logger 与 kernel.profiler 实现这些接口，并通过上下文注入给模块；作用域与计时标签前缀由上下文绑定。
 * 本文件只含类型声明，没有运行时代码。
 */

/** 作用域日志。作用域为模块 ID 或进程键，由上下文绑定。 */
export interface Logger {
  /**
   * @description 输出调试日志；调试级别关闭时直接丢弃。
   * @param message 日志正文，或返回正文的函数；函数形式只在调试级别开启时求值，避免热路径上无谓地拼接字符串。
   * @returns 无返回值。
   */
  debug(message: string | (() => string)): void;
  /**
   * @description 输出一般信息日志。
   * @param message 日志正文。
   * @returns 无返回值。
   */
  info(message: string): void;
  /**
   * @description 输出警告日志，用于可恢复的异常情况。
   * @param message 日志正文。
   * @returns 无返回值。
   */
  warn(message: string): void;
  /**
   * @description 输出错误日志。
   * @param message 日志正文。
   * @param error 可选的异常对象；经 errorMapper 规范化并映射到源码位置。
   * @returns 无返回值。
   */
  error(message: string, error?: unknown): void;
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
