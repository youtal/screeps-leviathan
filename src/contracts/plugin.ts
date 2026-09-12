/**
 * 文件摘要：发布插件清单、生命周期、上下文和框架控制接口。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
 */
import type { ModuleContext, CreateModuleContext } from './runtime';
import type { Profiler } from './profiler';
import type { CpuBudget, GameIntent, IntentReceipt } from './intent';
import type { PluginFailure } from './errorMapper';
import type { LoggerFactory } from './logging';
/** 注册描述；依赖字段引用插件 ID，provides 字段声明服务名，两者并非同一命名空间。 */
export interface PluginManifest {
  /** 插件和诊断的归属键；注册后保持稳定。 */
  id: string;
  /** 正整数插件协议版本；不触发持久化迁移。 */
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
}

/** 生命周期上下文在激活时创建，跨 tick 复用；tick 动态读取，不提供持久化能力。 */
export interface PluginContext extends ModuleContext {
  readonly pluginId: string;
  readonly tick: number;
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
 */
export interface LeviathanPlugin {
  manifest: PluginManifest;
  /** 每次激活调用一次；global reset、停用后重启会再次调用。 */
  setup?(context: PluginContext): void;
  /** 前处理，所有参与插件 setup 完成后按依赖顺序执行。 */
  onTickBegin?(context: PluginContext): void;
  /** 形成计划并提交意图；真正的动作调用统一在之后的 commit 中执行。 */
  onTickExecute?(context: PluginContext): void;
  /** 对已进入 begin 的插件逆序调用，包括 begin 自身抛错者；必须容忍不完整前处理。 */
  onTickEnd?(context: PluginContext): void;
}

/** 可选依赖注入及运行策略；默认依赖延迟到 loop 使用，导入模块不触发 Memory 解析。 */
export interface FrameworkOptions {
  /** 初始注册队列；完整依赖图到首次 tick 边界才验证。 */
  plugins?: readonly LeviathanPlugin[];
  /** 每次返回当前 Game，避免跨 tick 捕获过期对象；测试可注入模拟环境。 */
  getGame?: () => Game;
  /** 注入 Runtime 组装的日志工厂；缺省使用 core/logger 兜底工厂，仅供独立调用与测试。 */
  logging?: LoggerFactory;
  /** 提供基础 Runtime；框架仍会代理订阅、追加服务和意图能力。 */
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
  /** 同步诊断出口；其异常被吞并，防止覆盖业务故障。 */
  report?: (failure: PluginFailure) => void;
  /** 首次错误时加载 source map；必须同步返回 trace-mapping 可解析的数据。 */
  loadSourceMap?: () => any;
}
/** 诊断快照不允许修改框架内部状态；tick 在首次 loop 前为 undefined。 */
export interface FrameworkStatus {
  safeMode: boolean;
  tick: number | undefined;
  failures: PluginFailure[];
}
/** 注册命令在 tick 边界事务性应用；recover 只能在 loop 外调用。 */
export interface Framework {
  loop(): void;
  register(plugin: LeviathanPlugin): void;
  enable(id: string, enabled?: boolean): void;
  disable(id: string): void;
  unregister(id: string): void;
  recover(id: string): void;
  getStatus(): FrameworkStatus;
}
