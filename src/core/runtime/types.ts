/**
 * 文件摘要：定义 Runtime 的环境适配器、模块上下文、包装器和依赖注入选项。
 *
 * core/runtime 的类型协议层：createRuntime 与本目录的 env 适配器都按这里的接口
 * 装配，Profiler 通过 Wrap/HasWrap 参与注入，业务模块则只依赖 EnvContext 或
 * ModuleContext。
 *
 * 这些接口把业务模块对 Game、日志、EventBus 与 Profiler 的依赖集中为显式
 * 上下文，既保留 TypeScript 推导能力，也不产生额外运行时代码：类型在编译期被
 * 擦除，不会增加 Screeps 的 CPU 或 Memory 开销。
 *
 * 对 Bus/Profiler 的类型引用使用 `import type`，它只参与类型检查、不生成运行时
 * import，因此 runtime 与 eventBus/profiler 之间不会形成实际的循环依赖。
 */
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
 *
 * 约束写成 `(...args: any[]) => any` 而不是 `unknown[]`：一旦开启
 * strictFunctionTypes，函数参数会按逆变检查，具体签名的函数（例如
 * `(a: string) => void`）无法赋给 `(...args: unknown[]) => void`，会让 wrap 拒绝
 * 大多数业务函数。`any[]` 只用来放宽这一约束，包装实现仍负责原样转发参数与
 * 返回值；当前 tsconfig 未开启 strict，但类型约束不应依赖这一现状。
 */
export type Wrap = <F extends (...args: any[]) => any>(
  label: string,
  fn: F
) => F;

/**
 * 表示一个对象具备函数包裹能力。
 *
 * 目前主要由 Profiler 实现，也是 EnvMethods.profiler 的类型。把它拆成独立
 * 接口，是为了让 EnvMethods 可以只依赖最小能力，而不必直接依赖完整 Profiler
 * 接口（后者还带开关、重置与报告）。
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
 *
 * 字段说明：
 * - getObjectById 直接引用 `typeof Game.getObjectById`，保留 Screeps 类型声明
 *   中的泛型签名，调用方不需要再断言返回类型。
 * - log 的类型由 `ReturnType<typeof createLog>` 推导，日志等级方法的增减会
 *   自动同步；该 import 只出现在类型位置，编译后不会保留。
 * - profiler 是可选的包裹能力：Profiler 可能被禁用或创建失败，而且
 *   createEnvMethods 不填充它，运行时实例挂在 ModuleContext.profiler 上。
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

/**
 * 创建 root runtime 时可以注入的依赖。
 *
 * 这些选项主要服务于测试和未来的不同运行模式：
 * - bus：允许注入测试总线或已有总线。
 * - profiler：允许禁用、替换或复用 profiler；注入后 enableProfiler 不再生效。
 * - enableProfiler：控制默认 profiler 初始开关。
 * - getProfilerMemory：控制 profiler 数据落在哪里。它必须返回同一个常驻对象，
 *   访问器每次写入前都会重新调用它并原地累加；返回临时副本会让统计丢失。
 * - markProfilerMemoryDirty：与访问器配套，在 Profiler 原地写入前显式标脏，
 *   让宿主（Framework 的检查点分区）知道该把哪块数据写回，避免整棵 Memory
 *   重新序列化。
 *
 * 未提供 getProfilerMemory 时，createRuntime 使用闭包 heap 对象作为默认落点，
 * 统计不进入持久化 Memory。
 */
export interface RuntimeOptions {
  bus?: Bus;
  profiler?: Profiler | null;
  enableProfiler?: boolean;
  getProfilerMemory?: () => ProfilerMemory;
  markProfilerMemoryDirty?: () => void;
}
