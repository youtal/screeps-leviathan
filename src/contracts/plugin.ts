/**
 * 文件摘要
 *
 * 模块角色：contracts 中的插件与框架协议，约定业务模块如何注册、运行和取得依赖。
 *
 * 主要功能：声明插件清单、同步生命周期钩子、上下文能力、框架配置、控制方法和诊断快照。
 *
 * 实现过程：manifest 描述依赖与服务，setup 发布服务并登记清理；tick 钩子通过上下文查询环境、
 * 申请存储、检查 CPU 和提交意图，Framework 接口提供注册、停用、卸载与恢复操作。
 *
 * 技术要点：插件 ID 与服务名用途不同；依赖排序、阶段权限和命令在 tick 边界生效等规则由框架执行。
 * 这些接口本身不创建插件或保存状态，Runtime 必须由调用方显式提供。
 */
import type { ModuleContext, CoreRuntime } from './runtime';
import type { CpuBudget, GameIntent, IntentReceipt } from './intent';
import type { PluginFailure } from './errorMapper';
import type { ApplyMemoryAccessor } from './memory';
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

/**
 * 生命周期上下文在激活时创建，跨 tick 复用；tick 动态读取。
 *
 * memory 是框架按 pluginId 绑定好的申请入口：未装配 MemoryManager 时 apply 直接
 * 抛配置错误，而不是返回永远 pending 的句柄；申请成功与否由返回的 Accessor 表达。
 */
export interface PluginContext extends ModuleContext {
  readonly pluginId: string;
  readonly tick: number;
  readonly events: ModuleContext['bus'];
  readonly memory: ApplyMemoryAccessor;
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

/** Framework 运行策略；所有基础能力必须由 Core Runtime 显式提供。 */
export interface FrameworkOptions {
  /** 唯一 Core Runtime；Framework 只消费，不创建或替换其中的同级能力。 */
  runtime: CoreRuntime;
  /** 初始注册队列；完整依赖图到首次 tick 边界才验证。 */
  plugins?: readonly LeviathanPlugin[];
  /** 默认保留 5 CPU 用于收尾；这是准入阈值，不保证硬超时后还能执行 finally。 */
  reserveCpu?: number;
  /** 普通插件的 bucket 下限，默认 1000；关键插件仍受硬预算限制。 */
  minBucket?: number;
  /** 默认连续失败 3 个参与 tick 后熔断，需显式 recover。 */
  failureThreshold?: number;
}
/** 诊断快照不允许修改框架内部状态；tick 在首次 loop 前为 undefined。 */
export interface FrameworkStatus {
  /** 主 Memory 最近一次整串写入失败；成功后清空，独立于插件故障和 safeMode。 */
  memory: { rawWriteError: string | null };
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
