/**
 * 文件摘要：使用者设置的类型（contracts 层，设计见 docs/design/contracts/README.md 第 1 节；设置文件见架构设计 4.3）。
 *
 * src/settings.ts 为每个需要使用者设置的模块导出一个常量，命名为 `<模块名>Settings`，类型在这里以 `<模块名>Settings`
 * 接口定义；装配方读取后作为参数注入对应模块，模块自身不导入设置文件。新增模块的设置时，在此增加接口，
 * 在 src/settings.ts 增加同名常量。本文件只含类型声明，没有运行时代码。
 */
import type { LogLevelSwitches } from './log';

/** kernel.logger 的使用者设置。 */
export interface LoggerSettings {
  /** 各日志级别的默认开关，即双层开关的第一层；业务模块可经 ctx.log.configLevel 覆盖。 */
  readonly levels: LogLevelSwitches;
  /** 是否给日志前缀按级别上色（游戏控制台把输出当 HTML 渲染）。 */
  readonly color: boolean;
}
