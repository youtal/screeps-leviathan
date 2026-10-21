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
  /** 是否给日志前缀按级别上色；只在输出端能渲染 HTML（游戏中存在 console.logUnsafe）时生效。 */
  readonly color: boolean;
}

/** kernel.memory 的使用者设置。 */
export interface MemorySettings {
  /**
   * 每次提交轮转抽查的未标脏单元数，用于发现绕过访问器、直接修改只读引用的写入（架构 6.3、15.1）；0 关闭。
   * 每个被抽查的单元要完整编码一次，所以默认关闭，私服调试与场景测试时手动开启。
   */
  readonly auditUnits: number;
}

/** app.boot 的使用者设置（架构 11.8、11.9，设计见 docs/design/app/boot.md 第 8 节）。 */
export interface BootSettings {
  /**
   * 11.8 的 boot.autoClear：证据与备份满足时是否允许自动清空 Memory；关闭时改判 AMBIGUOUS 并通知人工。
   * 只约束自动判定的清空，人工确认 boot.force('FRESH_START') 不受它约束（docs/design/app/boot.md 第 6.1 节）。
   */
  readonly autoClear: boolean;
  /**
   * 只判定、发布模式，不执行初始化、备份、清空与软重置，也不写项目标记（11.9 的 boot.dryRun）。
   * 部署到新环境前先设为 true 观察判定结果；运行中可由控制台 boot.dryRun 临时覆盖。
   */
  readonly dryRun: boolean;
}

/** kernel.profiler 的使用者设置。 */
export interface ProfilerSettings {
  /** 是否对动态实例的钩子单独计时；默认关闭，只按模块计时。开启后每次实例钩子调用多一次计时记录。 */
  readonly instances: boolean;
}
