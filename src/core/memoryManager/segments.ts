/**
 * 文件摘要：Segment 信封的编解码与校验，以及固定页的容量检查。
 *
 * 模块位置：core/memoryManager 的 Segment 后端基础层；createMemoryManager 用它读写
 * 单页内容，不直接接触 RawMemory API（平台端口负责）。
 *
 * 输入输出：encodeEnvelope 把分区数据编码为带 owner/generation/dataVersion 的 JSON
 * 文本，超过页容量时抛错；parseEnvelope 解析并校验形状；matchesOwner 检查信封是否属于
 * 某个分区且代际/版本符合预期。校验失败返回错误描述而不是抛错，便于调用方区分
 * "数据损坏"与"搬迁中间态"。
 *
 * 约定：信封是 Segment 内唯一的数据结构，升级数据版本时与 payload 一起写入，
 * 因此主 Memory 目录不必记录每个分区的数据版本；页被其他工具占用或归属不符时
 * 一律视为不可写，不做覆盖。
 */
import type { JsonValue } from '@/contracts/memory';
import {
  ENVELOPE_SCHEMA_VERSION,
  SEGMENT_CAPACITY,
  type SegmentEnvelope,
} from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 编码信封。
 *
 * 容量按 JSON 文本的字符数检查（Screeps 单页 100 KB；精确字节口径属于待决事项）。
 * 超限直接抛错，由调用方保留旧数据并把错误写入分区诊断，绝不截断或拆分。
 */
export const encodeEnvelope = (envelope: SegmentEnvelope): string => {
  const text = JSON.stringify(envelope);
  if (text.length > SEGMENT_CAPACITY)
    throw new Error(
      'Segment payload exceeds capacity: ' + String(text.length) + ' chars'
    );
  return text;
};

/**
 * 解析信封；形状不合法（含空页被其他工具写入的普通文本）时返回 null。
 * 这里不校验 owner/generation，由 matchesOwner 单独判断，使调用方能区分
 * "不是一个信封"和"是信封但不属于本分区"。
 */
export const parseEnvelope = (
  text: string | undefined
): SegmentEnvelope | null => {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schemaVersion !== ENVELOPE_SCHEMA_VERSION) return null;
  if (!isRecord(parsed.owner)) return null;
  if (
    typeof parsed.owner.pluginId !== 'string' ||
    typeof parsed.owner.localId !== 'string'
  )
    return null;
  if (!Number.isInteger(parsed.generation)) return null;
  if (!Number.isInteger(parsed.dataVersion)) return null;
  return parsed as unknown as SegmentEnvelope;
};

/**
 * 归属与代际是否与期望一致；返回 null 表示匹配，否则是差异描述。
 *
 * dataVersion 只在调用方已经知道期望版本时传入（迁移校验）；从目录恢复时版本
 * 由信封本身提供，不能拿"尚未读取的 0"去比较，否则会把完好数据判成损坏。
 */
export const describeMismatch = (
  envelope: SegmentEnvelope | null,
  owner: { pluginId: string; localId: string },
  generation: number,
  dataVersion?: number
): string | null => {
  if (!envelope) return 'segment does not contain a valid envelope';
  if (
    envelope.owner.pluginId !== owner.pluginId ||
    envelope.owner.localId !== owner.localId
  )
    return (
      'segment belongs to ' +
      envelope.owner.pluginId +
      '/' +
      envelope.owner.localId
    );
  if (envelope.generation !== generation)
    return 'generation ' + envelope.generation + ' != ' + generation;
  if (dataVersion !== undefined && envelope.dataVersion !== dataVersion)
    return 'dataVersion ' + envelope.dataVersion + ' != ' + dataVersion;
  return null;
};

/** 组装信封；payload 必须已是可 JSON 序列化的键值对象。 */
export const createEnvelope = (
  owner: { pluginId: string; localId: string },
  generation: number,
  dataVersion: number,
  payload: JsonValue
): SegmentEnvelope => ({
  schemaVersion: ENVELOPE_SCHEMA_VERSION,
  owner,
  generation,
  dataVersion,
  payload,
});
