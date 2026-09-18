/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的 Segment 数据格式工具，为加载、迁移和校验提供共同规则。
 *
 * 主要功能：创建和编码页面数据，解析文本，并报告归属、分配代次或数据版本的不匹配。
 *
 * 实现过程：在 payload 外附带格式版本、owner、generation 和 dataVersion；编码时转为 JSON 并检查长度，
 * 解析时验证基本字段，describeMismatch 再与预期身份比较。
 *
 * 技术要点：无效或空文本解析为 null，超出容量的编码抛错；校验不替代业务对 payload 的验证。
 * 这些函数不缓存数据，也不读写实际 Segment，宿主操作由 platform 与管理器完成。
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
