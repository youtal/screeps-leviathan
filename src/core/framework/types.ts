/**
 * 文件摘要：定义 Framework 的插件清单、生命周期钩子、上下文、意图与持久化协议，是全项目插件开发的类型契约。
 * 本文件位于 core/framework 的类型层，被 createFramework、memoryInterceptor、intentBroker、pluginRegistry 与业务插件共同引用。
 *
 * 设计要点：上下文用泛型 M 关联插件 Memory 的静态形状，把可 JSON 序列化的持久数据与只能在单个 tick 内
 * 使用的执行闭包（GameIntent.execute、onDispose 回调）在类型上分开；类型只在编译期参与校验，
 * 运行时参数仍由各组件验证，因此此处不引入任何运行时代码或副作用。
 */
import type { ModuleContext, CreateModuleContext } from '../runtime/types';
import type { Profiler } from '../profiler';

/**
 * 持久化数据仅接受 JSON 值，禁止保存 Game 对象或执行函数。
 * 这里是编译期的"可落盘"边界：undefined、Symbol、函数与循环引用都无法通过 JSON.stringify，
 * 因此不允许出现在插件 Memory 的类型里；运行时的容器形状由 memoryInterceptor 校验。
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/**
 * 递归只读视图阻止正常 TypeScript 代码绕过 commit；运行时不创建 Proxy，也不产生额外 CPU 开销。
 * 条件类型先剥离数组分支，再用同态映射类型（homomorphic mapped type）保留各字段的可选性与
 * 字面量类型；第三条分支让 number/string 等叶子类型原样通过，避免把原始值错误地映射成对象。
 */
export type DeepReadonly<T> = T extends JsonValue[]
  ? ReadonlyArray<DeepReadonly<T[number]>>
  : T extends { [key: string]: JsonValue }
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** critical 变化后立即提交；checkpoint 按间隔合并提交。 */
export type PersistenceLayer = 'critical' | 'checkpoint';
/** 插件持久化声明；未声明时 Framework 不为该插件创建 Memory 分区，也不接受 migrate。 */
export interface PluginPersistenceConfig {
  layer: PersistenceLayer;
  /** 仅 checkpoint 使用，表示 dirty 后允许延迟的最大 tick 数；默认 100。 */
  checkpointInterval?: number;
}
/**
 * 诊断使用的执行位置；commit 是意图提交边界，framework 表示不属于插件的内核工作。
 * 该值同时是权限判据：订阅只允许在 setup，意图只允许在 tickExecute，Kernel 据此拒绝越权调用。
 */
export type Phase =
  | 'setup'
  | 'tickBegin'
  | 'tickExecute'
  | 'commit'
  | 'tickEnd'
  | 'dispose'
  | 'framework';
/** 注册描述；依赖字段引用插件 ID，provides 字段声明服务名，两者并非同一命名空间。 */
export interface PluginManifest {
  /** 插件、诊断和可选持久化命名空间的归属键；注册后保持稳定。 */
  id: string;
  /** 正整数 Memory 版本；升级时执行 migrate，不是发布包的语义化版本号。 */
  version: number;
  /** 必需依赖必须已注册；未启用、熔断或本 tick 不可用时挂起使用者。 */
  requires?: readonly string[];
  /** 已注册时参与排序；缺失不阻止运行，读取可选服务仍需处理不可用异常。 */
  optional?: readonly string[];
  /** 服务名全局独占；setup 成功前必须发布全部声明的服务。 */
  provides?: readonly string[];
  /** 仅在依赖已满足的候选之间比较，大值先执行；不覆盖拓扑约束。缺省 0，同值按注册顺序稳定排列。 */
  priority?: number;
  /** 仅基础服务使用；仍受硬 CPU 收尾边界限制。 */
  critical?: boolean;
  /** 不声明即不创建插件 Memory；需要跨 global 恢复的插件必须明确选择提交层。 */
  persistence?: PluginPersistenceConfig;
}
/** 单次调用的可序列化诊断；保留原始堆栈，在映射可用时额外附带源码位置。 */
export interface PluginFailure {
  tick: number;
  pluginId: string;
  phase: Phase;
  message: string;
  stack: string;
  mappedStack?: string;
  /** 为调用级 CPU 诊断预留；当前捕获器不填充，聚合耗时由 Profiler 保存。 */
  cpuUsed?: number;
}
/** ok 是判别字段；显式检查后 TypeScript 才能安全访问 value 或 failure。 */
export type ExecutionResult<T> =
  { ok: true; value: T } | { ok: false; failure: PluginFailure };
/**
 * 持久化的 tick 级健康状态；同 tick 多次失败只累计一次。
 * successes 是版本 1 schema 的兼容字段，当前不再逐 tick 累加，以免成功热路径持续标脏。
 */
export interface PluginHealth {
  failures: number;
  consecutiveFailures: number;
  successes: number;
  circuitOpen: boolean;
}
/** 多个通道或锁可以一起竞争，避免将游戏动作兼容规则硬编码进 Kernel。 */
export interface GameIntent {
  /** 与 channel 共同形成对象动作的互斥键；通常传入游戏对象 ID。 */
  subjectId: string;
  /** 业务定义动作通道；内核不推断 Screeps 各类动作之间的兼容关系。 */
  channel: string;
  /** 大值优先，相同值按本 tick 提交次序；默认 0。 */
  priority?: number;
  /** 额外的全局独占锁，可表达跨对象竞争；所有锁必须同时获得。 */
  locks?: readonly string[];
  /** 仅胜者在 commit 中同步调用；不能保存到 Memory，也不能跨 tick 复用 Game 对象。 */
  execute(): ScreepsReturnCode;
  /** 可选业务说明，保留在候选中；当前回执不复制此字段。 */
  describe?: string;
}
/** API 提交结果，不是下一 tick 的事实确认；accepted 也可能带非 OK 返回码。 */
export interface IntentReceipt {
  /** 从 0 开始的本 tick 提交序号；跨 tick 识别时需同时使用 tick。 */
  id: number;
  tick: number;
  pluginId: string;
  subjectId: string;
  channel: string;
  /** accepted 已调用；rejected 未胜出/插件失效；failed 抛错；deferred 因 CPU 暂缓。 */
  status: 'accepted' | 'rejected' | 'failed' | 'deferred';
  reason?: string;
  apiResult?: ScreepsReturnCode;
}
/** 实时采样预算，不预占 CPU；准入后运行时间仍由插件自行控制。 */
export interface CpuBudget {
  remaining(): number;
  admit(critical?: boolean): boolean;
}
/**
 * 插件持久状态的唯一读写入口。query 返回类型级深只读视图；commit 在回调前标脏，
 * 并把可变键值对象交给调用者集中修改。绕过 commit 修改对象属于协议违规。
 */
export interface PersistenceNamespace<M extends object = Record<string, JsonValue>> {
  query(): DeepReadonly<M>;
  commit<R>(mutator: (memory: M) => R): R;
}
/**
 * 在基础 Runtime 上添加受生命周期约束的能力；M 关联插件 Memory 的静态形状。
 * 上下文由 Kernel 在首次 setup 时创建并按插件缓存，同一激活周期内跨 tick 复用（tick 字段是
 * 访问器，每次读取当前 Game.time），global reset 或重新启用后重建。Game 对象不能跨 tick 保存，
 * 插件状态只能经 persistence 的稳定句柄访问，使 Framework 能准确决定哪些分区需要序列化与写回。
 */
export interface PluginContext<M extends object = Record<string, JsonValue>>
  extends ModuleContext {
  readonly pluginId: string;
  readonly tick: number;
  readonly persistence: PersistenceNamespace<M>;
  readonly events: ModuleContext['bus'];
  readonly cpu: CpuBudget;
  readonly services: {
    /** T 由使用者声明，运行时只校验服务归属与可用性，不验证 T 的结构。 */
    get<T>(name: string): T;
    /** 仅在当前插件 setup 中发布 manifest.provides 声明的服务。 */
    provide<T>(name: string, value: T): void;
  };
  readonly intents: {
    /** 仅当前插件 tickExecute 内可提交；返回序号用于关联回执。 */
    submit(intent: GameIntent): number;
    /** 返回本插件当前 tick 的回执副本；仲裁前尚无回执。 */
    receipts(): readonly IntentReceipt[];
    /** 返回当前 global 生命周期中上一轮回执的副本；global reset 后为空。 */
    previous(): readonly IntentReceipt[];
  };
  /** setup 注册清理函数；停用/卸载时释放订阅，重新启用后重新 setup。 */
  onDispose(cleanup: () => void): void;
}
/**
 * 插件只描述同步钩子，实例化/副作用放入 setup；异步返回会被错误边界拒绝。
 * 默认键值对象允许注册表容纳不同 Memory 形状；业务应显式指定 M 以获得类型检查。
 */
export interface LeviathanPlugin<M extends object = Record<string, any>> {
  manifest: PluginManifest;
  /** 每次激活调用一次；global reset、停用后重启会再次调用。 */
  setup?(context: PluginContext<M>): void;
  /** 前处理，所有参与插件 setup 完成后按依赖顺序执行。 */
  onTickBegin?(context: PluginContext<M>): void;
  /** 形成计划并提交意图；真正的动作调用统一在之后的 commit 中执行。 */
  onTickExecute?(context: PluginContext<M>): void;
  /** 对已进入 begin 的插件逆序调用，包括 begin 自身抛错者；必须容忍不完整前处理。 */
  onTickEnd?(context: PluginContext<M>): void;
  /** 直接接收旧键值对象并同步迁移至 manifest.version；首次从版本 0 开始。 */
  migrate?(memory: Record<string, JsonValue>, fromVersion: number): M;
}
/** 内核持久化区；intentReceipts 是版本 1 兼容槽位，运行时回执实际只保留在 heap。 */
export interface FrameworkState {
  pluginVersions: Record<string, number>;
  pluginHealth: Record<string, PluginHealth>;
  intentReceipts: IntentReceipt[];
  profiler: import('../profiler').ProfilerMemory;
}
/** 存放于 Memory.leviathan；schemaVersion 是内核模式版本，当前仅接受 1。 */
export interface FrameworkMemory {
  schemaVersion: number;
  framework: FrameworkState;
  plugins: Record<string, JsonValue>;
}
/** 存储端口可在测试中完全替换，不需要真正的 Screeps 全局对象。 */
export interface MemoryPort {
  /** 每个实例首次 loop 读取一次原始 JSON；空字符串按空根对象处理。 */
  read(): string;
  /** 写入原生 stringify 生成的完整 JSON；失败时保留 heap 根供后续重试。 */
  write(value: string): void;
  /** 将解析结果绑定到宿主 Memory；必须在成功迁移后执行。 */
  mount(value: Memory): void;
}
/** 可选依赖注入及运行策略；默认依赖延迟到 loop 使用，导入模块不触发 Memory 解析。 */
export interface FrameworkOptions {
  /** 初始注册队列；完整依赖图到首次 tick 边界才验证。 */
  plugins?: readonly LeviathanPlugin[];
  /** 每次返回当前 Game，避免跨 tick 捕获过期对象；测试可注入模拟环境。 */
  getGame?: () => Game;
  memoryPort?: MemoryPort;
  /** 提供基础 Runtime；框架仍会代理订阅、追加服务及 Memory 能力。 */
  createContext?: CreateModuleContext;
  /** undefined 使用内置实例，null 禁用观测；均不影响错误隔离。 */
  profiler?: Profiler | null;
  /** 内置 Profiler 的初始开关，默认 false；对注入实例无效。 */
  enableProfiler?: boolean;
  /** 默认保留 5 CPU 用于收尾；这是准入阈值，不保证硬超时后还能执行 finally。 */
  reserveCpu?: number;
  /** 普通插件的 bucket 下限，默认 1000；关键插件仍受硬预算限制。 */
  minBucket?: number;
  /** 默认连续失败 3 个参与 tick 后熔断，需显式 recover。 */
  failureThreshold?: number;
  /** Profiler 检查点间隔，默认 100 tick；设为 1 表示每个 dirty tick 提交。 */
  profilerCheckpointInterval?: number;
  /** 同步诊断出口；其异常被吞并，防止覆盖业务故障。 */
  report?: (failure: PluginFailure) => void;
  /** 首次错误时加载 source map；必须同步返回 trace-mapping 可解析的数据。 */
  loadSourceMap?: () => any;
}
