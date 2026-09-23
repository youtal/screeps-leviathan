/**
 * 文件摘要
 *
 * 模块角色：contracts 中的跨 tick 任务调度协议，连接业务插件与 TaskScheduler 内核能力。
 *
 * 主要功能：声明任务体 TaskBody、生成器每次恢复时读取的 TaskContext、任务实例的实时句柄
 * TaskHandle、按 owner 绑定的调度入口 TaskScheduler，以及 Runtime 组装、Framework 驱动的
 * 宿主生命周期端口 TaskHost。
 *
 * 实现过程：TaskBody 是返回生成器的普通函数，业务代码在生成器体内用 `yield` 声明安全点；
 * TaskHost.bind(owner) 派生出的 TaskScheduler 按 owner 隔离任务命名空间。submit 只保证实例
 * 存在：同 id 已有实例时无论处于什么状态都返回它，重算或重试由调用方先 release 再提交。
 * Framework 每个 tick 在 MemoryHost.end 之前调用 persist 写入跨 global 的重启记录，之后调用
 * drive，每开始一片前用调用方传入 CpuBudget 的 admit() 判断还能否继续（bucket 高水位时另有
 * 盈余额度）。
 *
 * 技术要点：本文件只声明类型，不创建生成器、不调度、不捕获异常；具体算法、公平性策略、
 * 失败归属和硬终止恢复的设计意图见 docs/design/core/taskScheduler.md，行为由
 * core/taskScheduler 的实现承诺。
 */
import type { CpuBudget } from './intent';
import type { PluginFailure } from './errorMapper';

/**
 * 任务体：收到跨多个 tick 共享的上下文，返回一个在安全点 yield 的生成器。
 *
 * 泛型 T 是任务完成后的返回值类型，透传到 Generator 的返回类型与 TaskHandle.result。
 * yield 的中间值固定为 void：任务不能借 yield 表达式向调度器传数据，安全点只是纯粹的
 * 让出信号；恢复时同样不接收调度器传入的值（Generator 第三个类型参数 void）。
 * 注意任务体是“返回生成器的函数”而不是生成器对象：带参数的生成器函数要包一层，
 * 例如 `() => planLayout('W1N1')`；直接传入 `planLayout('W1N1')` 的结果会被类型检查拒绝。
 */
export type TaskBody<T> = (context: TaskContext) => Generator<void, T, void>;

/**
 * 生成器每次恢复时读取的状态。
 *
 * 该对象在任务实例创建时只构造一次，字段是读取调度器内部状态的访问器；调度器在每次调用
 * next() 之前更新这些状态，任务读到的始终是当次恢复时的值。readonly 只约束任务这一侧的
 * 写入，调度器更新的是访问器背后的内部状态，不违反这里的只读契约。
 */
export interface TaskContext {
  /** 当前 tick；跨多个 tick 恢复时会更新，任务不应缓存该值用于推算经过的 tick 数。 */
  readonly tick: number;
  /**
   * 本任务在本 tick 已完成的各分片累计消耗的 CPU（Game.cpu.getUsed 前后差值），不含正在
   * 执行的这一片。只在每次恢复前更新，同一分片内部读到的是同一个值，因此只能用来决定
   * 下一片的粒度，不能在分片内部当作循环条件。
   */
  readonly used: number;
}

/**
 * 任务当前所处状态。
 *
 * queued/running 是活跃状态；done/failed/cancelled/expired 是终态。终态会一直保留，
 * 直到调用方 release、实例被闲置回收或 owner 被释放；期间同 id 的 submit 返回的仍是它。
 */
export type TaskState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'expired';

/**
 * 任务实例的实时句柄。
 *
 * state、result、failure 是读取实例当前状态的访问器，同一实例的句柄可以跨 tick 保存后
 * 继续读取；submit/get 对同一实例总是返回同一个句柄对象。实例被 release、闲置回收或随
 * owner 释放后，句柄停留在最后的状态（活跃时被释放即为 'cancelled'），不会指向之后按同一
 * id 新建的实例。
 */
export interface TaskHandle<T> {
  readonly id: string;
  readonly state: TaskState;
  /** state 为 'done' 时有效，其余状态下为 undefined。 */
  readonly result?: T;
  /**
   * state 为 'failed' 时给出结构化故障，与插件故障同构。pluginId 固定为提交该任务的
   * owner（即 bind 时传入的模块名），phase 固定为 'framework'：驱动发生在 Framework
   * 自己的收尾阶段，不属于任何插件的声明钩子，但归属信息在提交时已经确定，不需要
   * 借助 id 的命名约定间接表达提交者身份。因硬终止被中断的次数超过上限时，任务同样以
   * 'failed' 结束，message 注明被硬终止中断；连续多次 global reset 仍未完成的任务同样以
   * 'failed' 结束，message 注明经历的 reset 次数。
   */
  readonly failure?: PluginFailure;
  /**
   * 停止活跃实例：状态变为 'cancelled' 并释放生成器。实例本身保留，submit 仍返回它，
   * 直到 release、闲置回收或 owner 被释放；已处于终态时是空操作。
   */
  cancel(): void;
}

/** 提交任务时的可选配置；只在创建实例时生效，已有实例时被忽略。 */
export interface TaskOptions {
  /** 调度优先级，大者先获得 CPU；缺省 0。同优先级之间按分片轮转，不会永久饿死。 */
  priority?: number;
  /** 从实例创建起的存活上限（tick 数），超过即标记为 'expired' 并释放生成器。 */
  deadlineTicks?: number;
  /**
   * 低于该 bucket 时不驱动该任务；缺省取调度器配置的 defaultMinBucket（5000）。
   * 与 Framework 的 minBucket 分别配置：drive 同时要求 CpuBudget.admit() 通过，
   * 因此实际门限是两者中较高的一个。
   */
  minBucket?: number;
  /**
   * 本任务每 tick 最多使用的 CPU，是软上限：本 tick 累计消耗达到该值后不再开始新的
   * 一片，但正在执行的一片不会被打断，因此最多超出一片的消耗。被限住的 CPU 继续分给
   * 其他任务。缺省取调度器配置的 defaultMaxCpuPerTick（缺省不限）。
   */
  maxCpuPerTick?: number;
  /**
   * Profiler 标签与健康统计使用的分类键，必须来自固定且有限的集合——与
   * PluginManifest.id 不能按房间、任务等动态数据生成的约束同源：Profiler 与健康表
   * 都按键长期建表，动态键会造成无界增长。缺省回退到 id 本身；调用方一旦按业务
   * 动态拼接 id（例如按房间区分任务实例），必须显式提供固定的 label，否则动态 id
   * 会被当作 label 使用，在 Profiler 报告里产生无界增长的标签。
   */
  label?: string;
}

/**
 * 按 owner 绑定后的调度入口；业务代码通过 ModuleContext.tasks 或 PluginContext.tasks
 * 取得，不直接持有 TaskHost。owner 已经把不同模块的任务隔离在各自的命名空间里，
 * 因此 id 只需要在同一 owner 内唯一。owner 与 id 也用作持久记录的路径段，须为非空
 * 字符串，不能包含 NUL，也不能是 __proto__、prototype 或 constructor。
 */
export interface TaskScheduler {
  /**
   * 确保 id 对应的任务实例存在，并返回其句柄。
   *
   * 同 id 已有实例时，无论处于活跃状态还是终态，都直接返回该实例，本次传入的
   * body/options 被忽略。因此调用方可以每 tick 无条件调用：已完成的结果不会被重算，
   * 失败与过期保持可见。只有不存在实例时才调用 body 创建新实例（deadlineTicks 从这次
   * 创建起算）；body 在调用方的上下文中同步执行一次以取得生成器，body 本身抛错会直接
   * 从 submit 抛出。非法 id 在创建实例和调用 body 之前直接抛错。每次调用都会刷新实例的闲置计时。
   */
  submit<T>(id: string, body: TaskBody<T>, options?: TaskOptions): TaskHandle<T>;
  /** 按 id 查询实例句柄并刷新闲置计时；从未提交、已 release 或已被回收时返回 undefined。 */
  get<T>(id: string): TaskHandle<T> | undefined;
  /**
   * 释放 id 对应的实例：活跃则先取消，然后从注册表移除；不存在时是空操作。需要重算
   * 或在失败后重试时先 release，下一次 submit 会从 body 重新创建。
   */
  release(id: string): void;
}

/**
 * 宿主驱动的任务调度生命周期端口。
 *
 * 由 core/taskScheduler 实现，Runtime 组装为 CoreRuntime.tasks。Framework 在每个 tick
 * 的收尾阶段依次调用 persist（MemoryHost.end 之前）与 drive（MemoryHost.end 之后），并在
 * 释放插件时调用 releaseOwner。构造与 bind 都不产生调度副作用，形态与 MemoryHost 的
 * bind/begin/end 对齐。
 */
export interface TaskHost {
  /** 按 owner（模块名/插件 id）派生绑定后的调度入口；非法 owner 直接抛错，对同一 owner 重复调用是安全的。 */
  bind(owner: string): TaskScheduler;
  /**
   * 把本 tick 需要持久化的任务记录写入调度器的存储分区：登记新建的实例及其已经经历的
   * global reset 次数，清除已结束实例的记录。必须在 MemoryHost 的写入阶段（begin 与 end
   * 之间）调用，Framework 在 MemoryHost.end 之前调用一次；没有存储宿主或存储不可用时跳过，
   * 不抛出。记录只用于识别“每次都让 global 重建”的任务，见 docs/design/core/taskScheduler.md。
   */
  persist(tick: number): void;
  /**
   * 驱动一轮就绪任务：每开始一片前调用 cpu.admit()（普通插件的准入口径：bucket 达到
   * Framework 的 minBucket，且已用 CPU 低于常规额度 limit 减去 reserveCpu），任务因此主要
   * 使用本 tick 常规额度中插件没有用完的部分；bucket 达到调度器配置的高水位时，另可使用
   * 高于水位的盈余（每 tick 至多再用一份常规额度，并与 tickLimit 保持距离）。
   * 不保证清空队列，也不保证任何具体任务在本次调用内取得进展（例如全部任务都被各自的
   * minBucket 拦下）。
   * cpu 应当是驱动本轮插件用的同一个 CpuBudget。单个任务抛出的异常（包括硬终止后重建
   * 任务体时的异常）在内部捕获并写入其自身的 TaskHandle.failure，不会从 drive 抛出；
   * drive 本身抛出的异常代表调度器自身的实现故障，由调用方按宿主级故障处理。
   */
  drive(tick: number, cpu: CpuBudget): void;
  /**
   * 释放 owner 名下的全部实例（活跃的先取消）。Framework 在释放插件（停用、熔断、卸载、
   * 替换或 setup 失败）时调用，避免已释放插件的任务继续消耗 CPU、占用 heap。
   */
  releaseOwner(owner: string): void;
  /** 最小诊断快照，供故障排查与观测使用；不包含具体任务内容。 */
  getStatus(): { queued: number; running: number };
}
