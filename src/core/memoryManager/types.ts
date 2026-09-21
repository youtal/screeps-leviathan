/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的内部格式常量、平台端口与诊断类型，约束各实现文件之间的数据。
 *
 * 主要功能：集中提供命名空间键、schema 版本、主存储容量上限；声明主存储平台端口、
 * 整串提交失败的结构化诊断，以及 getStatus 返回的状态快照。
 *
 * 实现过程：只有常量是运行时内容；其余都是类型，编译后擦除。
 *
 * 技术要点：不执行读写或校验；公开的业务访问协议位于 contracts/memory。
 * 平台端口只含主 RawMemory 文本读写与当前 tick 查询，不含任何 Segment 能力。
 */

/** MemoryManager 在主存储根对象上的命名空间键；与其他根字段并存、互不覆盖。 */
export const NAMESPACE_KEY = 'memoryManager';

/** 旧版持久化命名空间：没有 memoryManager 命名空间时一次性导入，原字段原样保留。 */
export const LEGACY_NAMESPACE_KEY = 'leviathan';

/** 当前写出的命名空间 schema 版本；装载接受 1（转换）与 2，其余拒绝并保护原文本。 */
export const NAMESPACE_SCHEMA_VERSION = 2;

/**
 * 主存储序列化文本的长度上限：官方 driver 的 RawMemory.set 以 string.length 与
 * 2 * 1024 * 1024 比较，单位是 UTF-16 码元，不是 UTF-8 字节或 Unicode 码点。
 * 超限时整串写入被拒绝，按 capacity 阶段诊断，不覆盖有效文本。
 */
export const RAW_MEMORY_LIMIT = 2_097_152;

/**
 * 平台端口：隔离 Screeps 全局对象，测试以假实现注入。
 *
 * getTick 提供“真实的当前 tick”：同一执行栈中的回调无法改变它，管理器据此区分
 * 同步重入（传入更大的 tick）与硬终止后遗留的旧阶段。
 */
export interface MemoryPlatform {
  readRaw(): string;
  writeRaw(value: string): void;
  getTick(): number;
}

/** 整串提交失败所处的阶段；分区级阶段携带 owner/localId，整串级阶段不伪造归属。 */
export type WriteFailureStage = 'validate' | 'encode' | 'capacity' | 'platform';

/** 最近一次整串提交失败；提交成功后清空。 */
export interface WriteFailure {
  stage: WriteFailureStage;
  tick: number;
  message: string;
  owner?: string;
  localId?: string;
}

/** 管理器诊断快照：查询时生成，不在每 tick 分配。 */
export interface MemoryManagerStatus {
  /** 首次装载是否已成功发布。 */
  loaded: boolean;
  /** 装载故障（本 global 锁定、禁止写回）；null 表示没有。 */
  loadError: string | null;
  /** 最近一次整串提交失败的文本描述（分区级错误包含 owner/localId）；成功后为 null。 */
  rawWriteError: string | null;
  /** rawWriteError 的结构化形式。 */
  writeFailure: WriteFailure | null;
  /** 最近一次 begin 的 tick；尚未 begin 时为 -1。 */
  tick: number;
  /** 当前待提交的脏分区。 */
  dirty: { owner: string; localId: string }[];
  /** 是否存在待写出的结构变化（格式转换）。 */
  structureChanged: boolean;
  /** 已存储的全部分区（含本 global 未申请者），applied 表示已发布访问器。 */
  partitions: { owner: string; localId: string; dataVersion: number; applied: boolean }[];
  /** 装载时因 Segment 归属而忽略的身份。 */
  ignoredSegmentPartitions: { owner: string; localId: string }[];
  /** 保留的非托管根字段名。 */
  preservedRootKeys: string[];
}
