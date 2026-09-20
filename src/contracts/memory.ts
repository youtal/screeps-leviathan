/**
 * 文件摘要
 *
 * 模块角色：contracts 中的持久存储协议，是业务模块与 MemoryManager 之间的访问约定。
 *
 * 主要功能：声明分区申请、初始化与版本迁移、读写访问、宿主 begin/end 生命周期及最小写入诊断。
 *
 * 实现过程：按 owner 绑定申请函数，以 localId 和选项取得稳定访问器；每 tick 调用 access，
 * 根据 pending/ready 分支决定等待或通过 query、commit 访问数据。
 *
 * 技术要点：访问器可跨 tick 保留，ready 视图仅在签发 tick 和对应数据仍有效时使用。
 * DeepReadonly 只提供编译期约束；commit 抛错不保证回滚，也不表示已经写入存储。本文件不执行持久化。
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
/**
 * ready 视图仅在签发它的那个 tick 内有效：实现必须让跨 tick、分区进入 pending 或
 * 数据被重新加载后的调用失败，而不是继续写入可能已经脱离事实源的对象。
 * commit 同步、回调前标脏，抛错不回滚，也不等于已落盘。
 */
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

/**
 * 宿主驱动的 Memory 生命周期端口。
 *
 * 由 MemoryManager 实现，Runtime 组装，Framework 在 tick 边界调用：`begin` 在插件
 * 阶段之前准备存储与恢复，`end` 在插件收尾之后封存启动申请窗口、推进迁移并提交。
 * `bind` 为某个稳定 owner（pluginId 或模块名）绑定申请入口——配置错误必须直接抛错，
 * 不能返回永久 pending 的访问器；存储未就绪属于等待，用 pending 表达。
 */
export interface MemoryHost {
  /** 最小宿主诊断；实现可返回更多字段，Framework 只依赖整串写入故障。 */
  getStatus(): { rawWriteError: string | null };
  begin(tick: number): void;
  end(tick: number): void;
  /** 本轮未完成全部启动申请时延后封存窗口（例如框架提前进入安全模式）。 */
  deferStartupWindow(): void;
  bind(owner: string): ApplyMemoryAccessor;
}
