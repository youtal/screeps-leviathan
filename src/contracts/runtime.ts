/**
 * 文件摘要：发布模块上下文和上下文派生工厂。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
 */
import type { Bus } from './eventBus';
import type { Profiler } from './profiler';
import type { EnvContext } from './environment';
import type { LogOptions } from './logging';
import type { ApplyMemoryAccessor } from './memory';
import type { LoggerFactory } from './logging';
import type { MemoryHost } from './memory';
import type { ErrorMapper } from './errorMapper';
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
  /** 装配了 MemoryManager 时提供按模块名绑定的申请入口；未装配时省略。 */
  memory?: ApplyMemoryAccessor;
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
  readonly createContext: CreateModuleContext;
}
