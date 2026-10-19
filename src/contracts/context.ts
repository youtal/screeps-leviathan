/**
 * 文件摘要：模块上下文、实例上下文、阶段钩子与动态实例表（contracts 层，设计见 docs/design/contracts/README.md
 * 第 2、3 节，架构设计 4.4 tick 流水线、5.1 进程表、5.4 上下文）。
 *
 * kernel.context 为每个模块派生 ModuleContext，并惰性派生 InstanceContext；上下文在整个 global 生命周期内稳定。
 * 有状态的 kernel 能力只能经由上下文取得（架构设计 4.2）。钩子与实例表放在这里而不是 module.ts，
 * 使 contracts 的依赖图无环：本文件只依赖叶子文件 log、cpu、memory、mode。本文件只含类型声明，没有运行时代码。
 */
import type { CpuBudget } from './cpu';
import type { Logger, Measure } from './log';
import type { EntitySpace, PartitionFactory } from './memory';
import type { BootModeView } from './mode';

/** 模块 ID：小写驼峰，全局唯一，例如 'mining'。 */
export type ModuleId = string;

/**
 * 阶段钩子，按 sense → plan → arbitrate → act → move 的顺序调用。
 * 钩子不带参数：上下文在 setup 时由闭包持有，每 tick 调用不分配参数对象。每次调用各自处于独立的错误边界中。
 */
export interface PhaseHooks {
  /**
   * @description sense 阶段：读取并整理当 tick 世界事实，例如按归属分组 creep。
   * @returns 无返回值；只更新本模块的当 tick 缓存。
   */
  sense?(): void;
  /**
   * @description plan 阶段：声明需求，例如孵化、运输、视野与姿态请求。
   * @returns 无返回值；需求经服务接口登记。
   */
  plan?(): void;
  /**
   * @description arbitrate 阶段：仲裁类模块（colony、services）裁决各方请求并下发结果。
   * @returns 无返回值；仲裁结果供 act 阶段读取。
   */
  arbitrate?(): void;
  /**
   * @description act 阶段：执行工作动作（harvest、transfer、upgrade 等）并登记移动意图。
   * @returns 无返回值；动作直接提交给游戏 API。
   */
  act?(): void;
  /**
   * @description move 阶段：交通结算并统一提交 move，通常只有 movement 实现。
   * @returns 无返回值；统一提交本 tick 的移动。
   */
  move?(): void;
}

/** 动态实例的钩子。 */
export interface InstanceHooks extends PhaseHooks {
  /**
   * @description 实例被移除或软重置时调用，释放实例持有的 heap 缓存；持久数据保留在所属模块的存储单元中。
   * @returns 无返回值。
   */
  dispose?(): void;
}

/**
 * 模块的动态实例表。模块在自己掌握的集合发生变化时显式增删实例，kernel 不在每 tick 轮询实例清单。
 * 进程键为 `<模块 ID>:<实例键>`，由 kernel 拼接；实例键由模块从稳定事实派生，例如 `W1N1:<sourceId>`。
 */
export interface ProcessTable {
  /**
   * @description 添加动态实例；键已存在时忽略。create 只在实际添加时调用一次。
   * @param key 实例键（不含模块 ID），由模块从稳定事实派生，global reset 后保持不变。
   * @param create 以实例上下文创建实例钩子的工厂。
   * @returns 无返回值；新实例从下一个阶段开始参与调度。
   */
  add(key: string, create: (ctx: InstanceContext) => InstanceHooks): void;
  /**
   * @description 移除实例并调用其 dispose；键不存在时忽略。
   * @param key 实例键（不含模块 ID）。
   * @returns 无返回值。
   */
  remove(key: string): void;
  /**
   * @description 查询实例是否存在，不创建实例。
   * @param key 实例键（不含模块 ID）。
   * @returns 实例存在时为 true。
   */
  has(key: string): boolean;
}

export interface ModuleContext {
  readonly id: ModuleId;
  /** 作用域为模块 ID 的日志。 */
  readonly log: Logger;
  /** 标签前缀为模块 ID 的计时。 */
  readonly measure: Measure;
  readonly cpu: CpuBudget;
  /** 申请本模块的 Memory 分区。 */
  readonly memory: PartitionFactory;
  readonly rooms: EntitySpace;
  readonly creeps: EntitySpace;
  readonly flags: EntitySpace;
  /** 启动判定结果，只读。 */
  readonly mode: BootModeView;
  /** 本模块的动态实例表。 */
  readonly processes: ProcessTable;
  /**
   * @description 惰性派生并缓存实例上下文；同一键多次调用返回同一对象。
   * @param key 实例键（不含模块 ID）。
   * @returns 日志、计时与 CPU 归属都细到该实例的上下文。
   */
  instance(key: string): InstanceContext;
  /**
   * @description 登记软重置时的清理函数，用于释放模块级 heap 缓存。
   * @param fn 清理函数，软重置时调用一次。
   * @returns 无返回值。
   */
  onDispose(fn: () => void): void;
}

/** 实例上下文。实例的持久数据放在所属模块的分区或切片中，按实例键区分，因此这里不带存储接口。 */
export interface InstanceContext {
  /** 完整进程键 `<模块 ID>:<实例键>`。 */
  readonly key: string;
  /** 作用域为进程键的日志。 */
  readonly log: Logger;
  /** 按进程键聚合的计时。 */
  readonly measure: Measure;
  /** CPU 计入该实例。 */
  readonly cpu: CpuBudget;
}
