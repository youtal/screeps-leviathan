/**
 * 文件摘要：日志与计时的注入接口（contracts 层，设计见 docs/design/contracts/README.md 第 4 节）。
 *
 * kernel.logger 与 kernel.profiler 实现这些接口，并通过上下文注入给模块；作用域与计时标签前缀由上下文绑定。
 * 本文件只含类型声明，没有运行时代码。
 */

/** 作用域日志。作用域为模块 ID 或进程键，由上下文绑定。 */
export interface Logger {
  /** 调试日志；传入函数时只在调试级别开启时求值，避免热路径上无谓地拼接字符串。 */
  debug(message: string | (() => string)): void;
  info(message: string): void;
  warn(message: string): void;
  /** 错误日志；error 经 errorMapper 规范化并映射到源码位置。 */
  error(message: string, error?: unknown): void;
}

/**
 * 计时。用 begin/end 两次调用代替 `measure(op, fn)`，避免热路径每次创建闭包。
 * 计时标签为 `<作用域>.<op>`；op 必须取自有限集合，不得包含 tick、creep 名等无界字段。
 */
export interface Measure {
  /** 返回开始时的 CPU 读数，交给 end。 */
  begin(): number;
  end(op: string, start: number): void;
}
