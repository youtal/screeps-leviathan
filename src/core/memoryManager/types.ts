/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的内部存储格式与平台类型定义，约束各实现文件之间的数据。
 *
 * 主要功能：声明分配目录、Raw 分区、迁移记录、Segment 页面、平台方法及状态诊断，集中提供格式常量。
 *
 * 实现过程：用 backend 区分存储位置，用迁移 phase 描述复制到清理的阶段；
 * owner、generation 与 dataVersion 分别标识分区归属、分配代次和业务数据版本；
 * 迁移另保存 fromGeneration，供目录切换后的源页清理证明归属。
 *
 * 技术要点：默认管理 Segment 0–9，容量常量为 100000 字符；类型只描述格式，不执行验证或读写。
 * 公开的业务申请协议位于 contracts/memory，本文件的运行时内容仅为这些配置常量。
 */
import type { JsonValue } from '@/contracts/memory';

/** 固定使用的前 10 个 Segment，规划为 ID 0..9；不调度剩余页。 */
export const SEGMENT_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** MemoryManager 在主 Memory 根上的命名空间键；与旧 leviathan 布局并存、互不覆盖。 */
export const NAMESPACE_KEY = 'memoryManager';

/** 旧版持久化命名空间：只做一次性导入，不删除、不修改，保留回退能力。 */
export const LEGACY_NAMESPACE_KEY = 'leviathan';

/**
 * 单个 Segment 的容量上限（字符数）。
 *
 * Screeps 单页限制为 100 KB；这里按 JSON 文本的字符数计量，属于保守近似。
 * 精确的字节口径需要在目标运行时实测（设计文档 §8 的待决事项），当前实现
 * 在超出上限时拒绝写入并保留旧数据，不做自动拆分。
 */
export const SEGMENT_CAPACITY = 100_000;

/**
 * 主 Memory 序列化文本的长度上限：官方 driver 的 RawMemory.set 使用 string.length
 * 与 2 * 1024 * 1024 比较，单位是 UTF-16 码元，不是 UTF-8 字节或 Unicode 码点。
 * 核验来源与边界测试见 docs/audits/2026-09-20-remediation.md §9。
 * 超限时整串写入被拒绝并按 rawWriteError / writeError 诊断。
 */
export const RAW_MEMORY_LIMIT = 2_097_152;

/** 主 Memory 命名空间的当前 schema 版本；未知版本拒绝覆盖。 */
export const NAMESPACE_SCHEMA_VERSION = 1;

/** Segment 信封的 schema 版本。 */
export const ENVELOPE_SCHEMA_VERSION = 1;

/** 存储后端：主 RawMemory 或固定 Segment。 */
export type Backend = 'raw' | 'segment';

/** 分配目录中的一条记录；generation 用于识别搬迁前后的同一份数据。 */
export interface AllocationRecord {
  backend: Backend;
  /** 仅 segment 后端存在；由启动窗口的排名分配。 */
  segmentId?: number;
  generation: number;
}

/** Raw 后端分区：dataVersion 与 payload 一起保存，便于按分区独立迁移。 */
export interface RawPartitionRecord {
  dataVersion: number;
  payload: JsonValue;
}

/**
 * 一次搬迁的源与目标。
 *
 * dataVersion 在规划时确定并写入 journal：恢复阶段可能没有模块参与，回读校验
 * 必须依赖 journal 里的期望版本，而不是内存中的分区对象。
 */
export interface MigrationMove {
  pluginId: string;
  localId: string;
  dataVersion: number;
  from: Backend;
  fromSegmentId?: number;
  /** 源页代次；清理必须匹配。旧 journal 可缺省，但无法证明归属时保留源页。 */
  fromGeneration?: number;
  to: Backend;
  toSegmentId?: number;
}

/**
 * 迁移记录：同一时刻至多一个，按 phase 单步推进，可在任意一步之后承受 global reset。
 *
 * staged 保存搬迁数据的可恢复副本，键为 `${pluginId}/${localId}`：离开 Segment 的
 * 分区在主 Memory 中留副本，迁入 Segment 的分区在切换前也保留一份。只有目录切换
 * 完成后才允许清理。
 */
export interface MigrationRecord {
  generation: number;
  /**
   * copy 暂存并写目标页 → verify 回读校验 → switch 更新目录 →
   * cleanup 确认目录已写入后再清空被腾退的页。每一步之后都能承受 global reset。
   */
  phase: 'copy' | 'verify' | 'switch' | 'cleanup';
  reason: 'allocation' | 'preemption';
  moves: MigrationMove[];
  staged: Record<string, JsonValue>;
}

/** 主 Memory 命名空间；unknown 版本或非法记录必须拒绝写入并给出诊断。 */
export interface NamespaceV1 {
  schemaVersion: number;
  /** 持久单调递增的代际计数器：每次搬迁取新值，绝不回退。 */
  generationCounter: number;
  allocations: Record<string, Record<string, AllocationRecord>>;
  rawPartitions: Record<string, Record<string, RawPartitionRecord>>;
  migration: MigrationRecord | null;
}

/** Segment 信封：归属、代际与数据版本随 payload 一起写入。 */
export interface SegmentEnvelope {
  schemaVersion: number;
  owner: { pluginId: string; localId: string };
  generation: number;
  dataVersion: number;
  payload: JsonValue;
}

/**
 * 平台端口：把 RawMemory 与 Segment 的读写抽象出来。
 *
 * setActiveSegments 只请求激活，实际可见性由 activeSegments 在后续 tick 反映——
 * 测试桩必须模拟"下一 tick 才可见"，否则迁移与 pending 语义会被高估。
 * MemoryManager 排他占用固定页：激活请求提交精确的页集合，不保留外部工具的活动页。
 */
export interface MemoryPlatform {
  readRaw(): string;
  writeRaw(value: string): void;
  /** 当前可见的 Segment 内容；未激活或不存在时不含该键。 */
  readSegments(): Record<number, string>;
  writeSegment(id: number, value: string): void;
  /** 本 tick 可见（已激活）的 Segment ID；以 segments 对象的键为准。 */
  activeSegments(): readonly number[];
  activateSegments(ids: readonly number[]): void;
}

/** 分区当前是否可用；pending 只影响依赖该 Accessor 的行为。 */
export interface PartitionPending {
  reason:
    | 'loading'
    | 'segment-activating'
    | 'migration'
    | 'recovery'
    | 'verification';
  retryAt: number;
}

/** 管理器对外诊断快照；故障必须可读，不能只靠 pending 掩盖。 */
export interface MemoryManagerStatus {
  loaded: boolean;
  fault: string | null;
  /**
   * 主 Memory 整串写入的最近一次失败原因（体积超限、引擎抛错等）；写入成功后清空。
   * 与 fault（存储无法加载，阻断所有申请）不同，它只表示写入暂时失败、下一 tick 会重试，
   * 且不依赖是否存在待提交的 Raw 分区——宿主根字段或目录变化导致的失败同样会体现。
   */
  rawWriteError: string | null;
  tick: number;
  startupWindowOpen: boolean;
  /** 启动窗口是否因申请迟迟不收齐而被强制封存（超过延后上限）。 */
  startupWindowForced: boolean;
  startupDeferrals: number;
  allocations: {
    pluginId: string;
    localId: string;
    backend: Backend;
    segmentId?: number;
    pending: PartitionPending['reason'] | null;
    dirty: boolean;
    /**
     * 最近一次故障信息（可能已经恢复）。判断当前是否可用请看 pending 与 access()，
     * 不要把该字段当作"当前故障"；恢复成功不会清空它，便于回溯历史问题。
     */
    writeError: string | null;
  }[];
  migration: {
    generation: number;
    phase: MigrationRecord['phase'];
    reason: MigrationRecord['reason'];
    moves: number;
  } | null;
  /** 被其他工具数据或未认领信封占用的页：不参与分配，也不会被写入。 */
  reservedSegments: { segmentId: number; reason: string }[];
  /** 最近一次分配规划中因数据未装载或损坏而落选的候选及原因。 */
  allocationSkipped: { pluginId: string; localId: string; reason: string }[];
  /** 尚未观察到内容的页：未观察前不允许写入。 */
  unobservedSegments: number[];
  /** 未被任何分区认领的主 Memory 根字段名，用于确认外部数据未被覆盖。 */
  preservedRootKeys: string[];
}
