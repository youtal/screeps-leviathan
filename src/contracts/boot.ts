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

/** 原始 Memory 的概要，供启动判定使用。 */
export interface RawMemorySummary {
  /** 原始文本为空或为 '{}'。 */
  readonly empty: boolean;
  /** 能否解析为对象。 */
  readonly parsed: boolean;
  readonly rootKeys: readonly string[];
  /** 结构合法的项目标记，否则为 null。 */
  readonly marker: DeepReadonly<ProjectMarker> | null;
}

/** 备份进度：进行中、已完成、失败。 */
export type BackupState = "pending" | "done" | "failed";

/** boot 阶段的特权操作（架构设计 5.6）。只在 boot 阶段有效，其他阶段调用即报错。 */
export interface BootPort {
  summary(): RawMemorySummary;
  /** 把原始 Memory 写入备份区；可能跨 tick，重复调用推进进度。 */
  backup(): BackupState;
  /** 整体清空 Memory，并按当前 epoch + 1 重建项目标记。 */
  clearMemory(): void;
  /** 清空本 shard 的 InterShardMemory；不可用时什么也不做。 */
  clearInterShard(): void;
  /** 软重置，下一 tick 生效（架构设计 5.5）。 */
  softReset(): void;
}

/** app.boot 的上下文：在模块上下文之外增加特权端口、项目标记与模式写入。 */
export interface BootContext extends ModuleContext {
  readonly port: BootPort;
  readonly sys: Accessor<ProjectMarker>;
  setMode(view: BootModeView): void;
}

/** 启动判定的定义。kernel 只接受一个，由 app.boot 提供，在每 tick 的 boot 阶段最先运行。 */
export interface BootDefinition {
  setup(ctx: BootContext): { boot(): void };
}
