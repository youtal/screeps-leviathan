/**
 * 文件摘要：启动判定相关的接口（contracts 层，设计见 docs/design/contracts/README.md 第 6 节，
 * 架构设计 5.6 boot 特权端口、6.7 项目标记、第 11 章启动判定）。
 *
 * 模式与只读视图定义在 mode.ts；BootPort、项目标记的访问器与 setMode 只出现在 app.boot 的 BootContext 中。
 * 本文件只含类型声明，没有运行时代码。
 */
import type { ModuleContext } from "./context";
import type { Accessor, DeepReadonly } from "./memory";
import type { BootMode, BootModeView, Strength } from "./mode";

/** 项目标记 Memory[NS].sys，字段含义与更新时机见架构设计 6.7。 */
export type ProjectMarker = {
  sig: string;
  schema: number;
  /** 当前 shard 名，私服为 'x'。 */
  shard: string;
  epoch: number;
  lastRun: number;
  release: string;
  /** 世界指纹：本方房间名、spawn id、creep 数量。 */
  fp: { rooms: string[]; spawnIds: string[]; creepCount: number };
  mode: {
    mode: BootMode;
    strength: Strength;
    since: number;
    evidence: string[];
  };
};

/**
 * 原始 Memory 的概要，供启动判定使用；内容是本 kernel 实例加载时的原貌，之后的写入、迁移与清空都不改变它。
 * 概要只校验项目标记，不代表 Memory 能够加载：标记合法而命名空间其余结构不合法时，访问 sys 抛错
 * （docs/design/kernel/bootPort.md 第 3 节"概要与加载"）。
 */
export interface RawMemorySummary {
  /** 架构设计 11.3 的 EMPTY：文本为空白，或根键只有 creeps/spawns/rooms/flags/powerCreeps 且值都是空对象。 */
  readonly empty: boolean;
  /** 能否解析为对象。 */
  readonly parsed: boolean;
  readonly rootKeys: readonly string[];
  /**
   * 签名相符的项目标记，否则为 null。schema 与当前版本相同时按当前结构完整校验，不合法为 null；
   * 不同时只保证 sig 与 schema 两个字段，其余字段可能属于其他版本的结构（供判定 OURS_NEWER）。
   */
  readonly marker: DeepReadonly<ProjectMarker> | null;
}

/** 备份进度：进行中、已完成、失败。 */
export type BackupState = "pending" | "done" | "failed";

/** boot 阶段的特权操作（架构设计 5.6）。只在 boot 阶段有效，其他阶段调用即报错。 */
export interface BootPort {
  /**
   * @description 读取原始 Memory 的概要，不触发全局 Memory 的惰性解析，也不修改存储。
   * @returns 原始文本是否为空、能否解析、根键列表及结构合法的项目标记。
   * @throws {Error} 不在 boot 阶段调用。
   */
  summary(): RawMemorySummary;
  /**
   * @description 把本 kernel 实例加载时的原始 Memory 写入 segment 备份区并回读校验；跨 tick 完成，重复调用推进进度。
   * 返回 pending 的 tick 为暂停 tick：kernel 跳过普通模块 setup 与业务阶段，保证备份完成前没有动作改变开局证据。
   * @returns 备份进度：pending 表示仍需在后续 tick 继续调用，done 表示已完成，failed 表示无法完成（超过备份区容量或回读不一致）。
   * @throws {Error} 不在 boot 阶段调用。
   */
  backup(): BackupState;
  /**
   * @description Memory 为 empty（本项目命名空间缺失、加载成功）时加入本项目命名空间，保留其他根键；
   * 项目标记由 kernel 生成，epoch 为 1，指纹与模式为占位值，boot 随后在同一 tick 经 sys 写入。
   * @returns 无返回值；Memory 随即就绪，等待本 tick 提交。
   * @throws {Error} 不在 boot 阶段调用，或 Memory 不是 empty。
   */
  initialize(): void;
  /**
   * @description 整体清空主 Memory，并按当前 epoch + 1 重建项目标记；属于不可逆操作，须先满足闸门条件（架构设计 11.8）。
   * @returns 无返回值；清空并重建项目标记，等待本 tick 提交。
   * @throws {Error} 不在 boot 阶段调用，或本 kernel 实例的普通模块已 setup（须先软重置）。
   */
  clearMemory(): void;
  /**
   * @description 清空本 shard 的 InterShardMemory；运行环境没有 InterShardMemory 时什么也不做。
   * @returns 无返回值；清空本 shard 的 InterShardMemory 内容。
   * @throws {Error} 不在 boot 阶段调用。
   */
  clearInterShard(): void;
  /**
   * @description 请求软重置：丢弃 heap 缓存、进程实例与路径缓存，效果等同于一次 global reset（架构设计 5.5）。
   * 本 tick 为暂停 tick：跳过业务阶段但照常提交。boot 钩子在同一 tick 抛错时，登记作废。
   * @returns 无返回值；软重置在下一 tick 生效。
   * @throws {Error} 不在 boot 阶段调用。
   */
  softReset(): void;
}

/** app.boot 的上下文：在模块上下文之外增加特权端口、项目标记与模式写入。 */
export interface BootContext extends ModuleContext {
  readonly port: BootPort;
  readonly sys: Accessor<ProjectMarker>;
  /**
   * @description 发布本次启动判定的结果，所有模块经只读的 BootModeView 看到更新后的模式。
   * @param view 判定得到的模式、证据强度与进入该模式的 tick。
   * @returns 无返回值；更新注入给各模块的模式视图。
   */
  setMode(view: BootModeView): void;
}

/** 启动判定的定义。kernel 只接受一个，由 app.boot 提供，在每 tick 的 boot 阶段最先运行。 */
export interface BootDefinition {
  /**
   * @description 每个 global 调用一次，取得 boot 阶段的钩子；上下文在此时由闭包持有。
   * @param ctx boot 专用上下文，包含特权端口、项目标记访问器与模式写入。
   * @returns 含 boot 钩子的对象。
   */
  setup(ctx: BootContext): {
    /**
     * @description 每 tick 最先运行的启动判定：global reset 时完整判定，平时只检查廉价不变量（架构设计 11.1）。
     * @returns 无返回值；判定结果经 setMode 发布，不可逆操作经 port 执行。
     */
    boot(): void;
  };
}
