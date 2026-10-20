/**
 * 文件摘要：控制台命令注册接口（contracts 层，设计见 docs/design/kernel/console.md 第 3 节，架构设计 5.8、11.9）。
 *
 * kernel.console 实现 ConsoleRegistry，并经 ModuleContext.console 注入给模块，命名空间为模块 id：
 * boot 注册的 assess 在游戏控制台中写作 `boot.assess()`。命令在主循环之后、同一全局作用域中求值，
 * 对 Memory 的写入在下一 tick 提交。本文件只含类型声明，没有运行时代码。
 */

/** 命令或设置名：小写驼峰，取自有限集合，不得随实例或实体增长。 */
export type CommandName = string;

/** 一个命名空间的命令注册器。注册即安装为全局对象 `<命名空间>` 上的方法或属性。 */
export interface ConsoleRegistry {
  /**
   * @description 注册命令 `<命名空间>.<name>(...args)`。处理函数抛错时，控制台输出 `错误：<消息>` 并记录日志；
   * 返回字符串原样输出，undefined 输出 `ok`，其他值经 JSON.stringify 转为文本（过长时截断）。
   * @param name 命令名；与本命名空间已有的命令或设置重名时被拒绝并记录错误。
   * @param help 一行说明，由 `<命名空间>.help()` 列出。
   * @param fn 处理函数，自行校验参数，参数不合法时抛错。
   * @returns 无返回值。
   */
  command(name: CommandName, help: string, fn: (...args: readonly unknown[]) => unknown): void;
  /**
   * @description 注册可读写的设置 `<命名空间>.<name>`，例如 `boot.dryRun = true`（架构 11.9）。
   * 读取经 get；赋值经 set，set 抛错时记录日志并忽略本次赋值。
   * @param name 设置名；与已有命令或设置重名时被拒绝并记录错误。
   * @param help 一行说明，应写明如何确认生效（例如再次读取）。
   * @param get 读取当前值。
   * @param set 校验并写入新值，不合法时抛错。
   * @returns 无返回值。
   */
  setting(name: CommandName, help: string, get: () => unknown, set: (value: unknown) => void): void;
}
