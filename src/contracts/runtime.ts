/**
 * 文件摘要
 *
 * 模块角色：contracts 中的 Runtime 协议，连接 Core 装配、Framework 和模块上下文。
 *
 * 主要功能：声明完整 CoreRuntime、业务可用的 ModuleContext，以及按模块名派生上下文的方法。
 *
 * 实现过程：CoreRuntime 汇集日志、总线、存储、计时、错误处理和任务调度接口；createContext
 * 接收模块名与日志选项，返回带环境、共享总线、可空 Profiler、可选存储申请入口和可选任务
 * 调度入口的上下文。
 *
 * 技术要点：只依赖其他契约；readonly 限制字段赋值，不冻结实例内部状态。
 * getGame 要在调用时取得游戏对象，消费者不可跨 tick 保存结果；本文件不创建任何具体能力。
 */
import type { Bus } from './eventBus';
import type { Profiler } from './profiler';
import type { EnvContext } from './environment';
import type { LogOptions } from './logging';
import type { ApplyMemoryAccessor } from './memory';
import type { LoggerFactory } from './logging';
import type { MemoryHost } from './memory';
import type { ErrorMapper } from './errorMapper';
import type { TaskHost, TaskScheduler } from './task';
/**
 * 派生模块上下文时的可选配置。
 *
 * log 作为作用域等级覆盖传给注入的日志工厂。
 * notify 是该模块对装配级邮件策略的覆盖：undefined 跟随装配配置，false 强制关闭，
 * true 在装配允许时开启 error 邮件。
 *
 * 两个选项都只作用于本次派生出的 env，不影响共享的 bus/profiler。
 */
export interface ModuleContextOptions {
  log?: LogOptions;
  notify?: boolean;
}

/**
 * 普通模块拿到的上下文形态。
 *
 * 它共享 root runtime 中的框架级单例：
 * - bus：所有模块共用同一条消息总线。
 * - profiler：所有模块共用同一个性能统计器。
 *
 * 同时它拥有独立 env：
 * - env.log 会使用模块名作为前缀。
 * - env 的 Game 访问方法可以在测试中整体替换。
 *
 * profiler 为 null 表示本次运行没有可用的 Profiler（注入 null 或创建失败），
 * 调用方必须先判空再 wrap。
 */
export interface ModuleContext extends EnvContext {
  bus: Bus;
  profiler: Profiler | null;
  /**
   * 按模块名绑定的分区申请入口。createRuntime 总会提供；保留可选是为了允许测试替身或
   * 特殊宿主手工构造不含存储能力的上下文。
   */
  memory?: ApplyMemoryAccessor;
  /**
   * 按模块名绑定的任务调度入口。createRuntime 总会提供，可选的原因与 memory 一致：
   * 允许测试替身或特殊宿主手工构造不含任务调度能力的上下文。模块名与插件 id 共用
   * 同一个 owner 命名空间，因此不能为空；普通模块没有插件生命周期，不再查询的任务由
   * 调度器的闲置回收释放。
   */
  tasks?: TaskScheduler;
}

export type CreateModuleContext = (
  moduleName: string,
  options?: ModuleContextOptions
) => ModuleContext;

/**
 * Core 组合根一次性创建并发布的完整运行时。
 *
 * 具体 Core 模块只实现各自契约，不直接导入同级实现；Framework 也只消费本契约，
 * 不再自行创建基础能力。这样实例唯一性、初始化顺序和依赖方向都由 Runtime 集中保证。
 */
export interface CoreRuntime {
  /** 始终在调用时取得本 tick 的 Game，禁止消费者跨 tick 保存返回对象。 */
  readonly getGame: () => Game;
  readonly logging: LoggerFactory;
  readonly bus: Bus;
  readonly memory: MemoryHost;
  readonly profiler: Profiler | null;
  readonly errorMapper: ErrorMapper;
  readonly tasks: TaskHost;
  readonly createContext: CreateModuleContext;
}
