/**
 * 文件摘要：发布 MemoryManager 的申请与访问协议；仅契约交付，不提供存储实现。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
 */
/** JSON 值的静态边界；循环引用、运行时输入及容量仍须实现校验。 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** 同态映射递归保留元组及可选字段；仅编译期只读，不冻结或克隆对象。 */
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export type PersistenceLayer = 'critical' | 'checkpoint';
/** retryAt 是建议重试 tick，不保证到期就绪；不得因此停用模块的无关行为。 */
export type MemoryPendingReason =
  'loading' | 'segment-activating' | 'migration' | 'recovery' | 'verification';
/** ready 视图仅当 tick 有效；commit 同步、回调前标脏，抛错不回滚，也不等于已落盘。 */
export type MemoryAccess<M extends object> =
  | { status: 'pending'; reason: MemoryPendingReason; retryAt: number }
  | {
      status: 'ready';
      query(): DeepReadonly<M>;
      commit<R>(mutator: (memory: M) => R): R;
    };
/** 稳定句柄可跨 tick 保留，每 tick 必须重新 access 并收窄状态。 */
export interface MemoryAccessor<M extends object> {
  access(): MemoryAccess<M>;
}
/** 初始化产生新数据；迁移接收未知旧数据，调用者负责验证并返回目标版本形状。 */
export interface MemoryApplicationOptions<M extends object> {
  priority?: number;
  version: number;
  initialize(): M;
  migrate?(memory: unknown, fromVersion: number): M;
  layer: PersistenceLayer;
  /** 仅 checkpoint 可用，正整数；默认 100 tick。 */
  checkpointInterval?: number;
}
/** 由装配方绑定稳定 pluginId，localId 由模块保证稳定；不暴露物理后端。 */
export type ApplyMemoryAccessor = <M extends object>(
  localId: string,
  options: MemoryApplicationOptions<M>
) => MemoryAccessor<M>;
