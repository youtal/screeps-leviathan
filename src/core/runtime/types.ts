import type { Bus } from '@/core/eventBus';
import type { Profiler, ProfilerMemory } from '@/core/profiler';
import { createLog } from '@/utils/console';

/**
 * 函数包裹器类型。
 *
 * Profiler 会通过 wrap 接收一个业务函数，并返回一个与原函数签名完全一致的函数。
 * 这样调用方可以在不改变参数、返回值和 this 以外调用方式的前提下，把统计逻辑织入执行路径。
 *
 * 泛型 F 保留原始函数类型：
 * - 参数列表不会退化为 unknown[]。
 * - 返回值不会丢失。
 * - 调用方拿到的仍然是原函数的类型体验。
 */
export type Wrap = <F extends (...args: any[]) => any>(
  label: string,
  fn: F
) => F;

/**
 * 表示一个对象具备函数包裹能力。
 *
 * 目前主要由 Profiler 实现。把它拆成独立接口，是为了让 EnvMethods
 * 可以只依赖最小能力，而不必直接依赖完整 Profiler 接口。
 */
export interface HasWrap {
  wrap: Wrap;
}

/**
 * 模块访问 Screeps 运行时的统一适配层。
 *
 * 它把全局对象 Game 的访问收敛为一组可替换的方法，并附带模块级 log。
 * 这样模块在测试时可以注入假环境，在运行时则访问真实 Screeps API。
 *
 * log 由 createEnvMethods 按模块名创建，因此不同模块可以拥有不同日志前缀。
 */
export interface EnvMethods {
  getGame: () => Game;
  getRoom: (roomName: string) => Room | undefined;
  getFlag: (flagName: string) => Flag | undefined;
  getCreep: (creepName: string) => Creep | undefined;
  getPowerCreep: (powerCreepName: string) => PowerCreep | undefined;
  getObjectById: typeof Game.getObjectById;
  log: ReturnType<typeof createLog>;
  profiler?: HasWrap;
}

/**
 * 表示一个模块需要 env 依赖。
 *
 * 业务模块通常不会直接依赖完整 runtime，而是声明自己需要 ModuleContext
 * 或 EnvContext。这样模块可以保持可复用，不知道上下文来自 app 层还是测试。
 */
export interface EnvContext {
  env: EnvMethods;
}

/**
 * 派生模块上下文时的可选配置。
 *
 * log 会传给 createLog，用于覆盖默认日志开关。
 * notify 控制该模块的错误日志是否调用 Game.notify。
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
 */
export type CreateModuleContext = (
  moduleName: string,
  options?: ModuleContextOptions
) => ModuleContext;

/**
 * 创建 root runtime 时可以注入的依赖。
 *
 * 这些选项主要服务于测试和未来的不同运行模式：
 * - bus：允许注入测试总线或已有总线。
 * - profiler：允许禁用、替换或复用 profiler。
 * - enableProfiler：控制默认 profiler 初始开关。
 * - getProfilerMemory：控制 profiler 数据落在哪里。
 */
export interface RuntimeOptions {
  bus?: Bus;
  profiler?: Profiler | null;
  enableProfiler?: boolean;
  getProfilerMemory?: () => ProfilerMemory;
}
