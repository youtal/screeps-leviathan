/**
 * 文件摘要：发布模块上下文和上下文派生工厂。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
 */
import type { Bus } from './eventBus';
import type { Profiler } from './profiler';
import type { EnvContext } from './environment';
import type { LogOptions } from './logging';
/**
 * 派生模块上下文时的可选配置。
 *
 * log 会传给 createLog，用于覆盖默认日志开关。
 * notify 控制该模块的错误日志是否调用 Game.notify。
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
}

/**
 * createRuntime 的返回类型。
 *
 * 当前 runtime 不直接暴露 root context，而是返回一个模块上下文工厂。
 * 这样 app 层可以创建唯一 root runtime，同时普通模块只能拿到派生后的
 * ModuleContext，避免直接操作 root 单例生命周期。
 *
 * options 只影响本次派生出的 env（日志开关与 notify），共享单例不随调用改变。
 */
export type CreateModuleContext = (
  moduleName: string,
  options?: ModuleContextOptions
) => ModuleContext;
