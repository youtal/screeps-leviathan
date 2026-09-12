/**
 * 文件摘要：发布性能观测及最小函数包装能力。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
 */
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
 * Profiler 对外暴露的能力。
 *
 * 它既可以作为 HasWrap 提供函数包裹，也可以在运行时开关、重置和输出报告。
 * 这里没有暴露内部 memory accessor，调用方只能通过这些受控方法操作统计器。
 *
 * wrap 复用 runtime 的 HasWrap 协议，因此只依赖“能包裹函数”的调用方无需引入完整
 * Profiler 类型；report 的 detailed 参数目前是占位，filter 为空串时输出全量报告。
 */
export interface Profiler extends HasWrap {
  enable(): void;
  disable(): void;
  reset(): void;
  report(detailed?: boolean, filter?: string): void;
}
