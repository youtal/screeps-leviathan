/**
 * 文件摘要：kernel.memory 的项目标记校验与原始 Memory 概要（设计见 docs/design/kernel/memory.md、
 * docs/design/kernel/bootPort.md 第 3 节，架构设计 6.7 项目标记、11.3 memState）。
 *
 * 输入为加载时解析得到的根值（或解析失败），输出供 boot 特权端口使用的只读概要：是否为 11.3 的 EMPTY、
 * 能否解析为对象、根键与签名相符的项目标记。概要在每个 Memory 实例加载时计算一次，深冻结后缓存，
 * 之后 sys 写入、迁移或清空都不会改变它，boot 看到的始终是本实例加载时的原貌。
 * 本文件只有纯函数，没有模块级可变状态。
 */
import type { ProjectMarker, RawMemorySummary } from '@/contracts/boot';
import type { DeepReadonly } from '@/contracts/memory';
import { copyJson, isObject } from './json';

/** 项目标记校验所需的装配身份。 */
export interface MarkerIdentity {
  readonly signature: string;
  readonly schema: number;
}

/** 11.3 中 EMPTY 允许出现的引擎默认根键：值都是没有键的对象时，Memory 仍视为空。 */
const ENGINE_KEYS: ReadonlySet<string> = new Set(['creeps', 'spawns', 'rooms', 'flags', 'powerCreeps']);

/** 合法的运营模式，与 contracts 的 BootMode 一致。 */
const MODES: ReadonlySet<unknown> = new Set(['NORMAL', 'FRESH_START', 'RECOVERY', 'TAKEOVER', 'SELF_ADOPT',
  'SHARD_SEED', 'STRANDED', 'DORMANT', 'AMBIGUOUS']);

/** 原始文本无法读取或无法解析为对象时的概要；冻结后共享，不含任何可变状态。 */
export const UNPARSED_SUMMARY: RawMemorySummary = Object.freeze({ empty: false, parsed: false,
  rootKeys: Object.freeze([]), marker: null });

/**
 * @description 判断值是否为非负安全整数。
 * @param value 待判断的值。
 * @returns 是非负安全整数时为 true。
 */
const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * @description 判断值是否为字符串数组。
 * @param value 待判断的值。
 * @returns 是数组且每个元素都是字符串时为 true。
 */
const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every((v) => typeof v === 'string');

/**
 * @description 按当前代码的结构校验项目标记：签名与 schema 必须与装配身份一致，各字段类型合法。
 * 当前世界是否与指纹相符由 boot 判定，这里不检查。不校验 JSON 合法性（循环、访问器等），由调用方按需先行校验。
 * @param value 待判断的项目标记。
 * @param identity 装配配置的签名与 schema。
 * @returns 身份匹配且字段结构合法时为 true，否则为 false；true 同时收窄输入类型。
 */
export const checkMarker = (value: unknown, identity: MarkerIdentity): value is ProjectMarker => {
  if (!isObject(value) || value.sig !== identity.signature || value.schema !== identity.schema
    || typeof value.shard !== 'string' || typeof value.release !== 'string'
    || !isCount(value.epoch) || !isCount(value.lastRun) || !isObject(value.fp) || !isObject(value.mode)) return false;
  const { fp, mode } = value;
  return isStrings(fp.rooms) && isStrings(fp.spawnIds) && isCount(fp.creepCount)
    && MODES.has(mode.mode) && (mode.strength === 'strong' || mode.strength === 'medium')
    && isCount(mode.since) && isStrings(mode.evidence);
};

/**
 * @description 递归冻结 JSON 树，使缓存的概要不能被 boot 修改。
 * @template T 输入类型。
 * @param value 由 copyJson 得到的独立副本。
 * @returns 冻结后的同一对象。
 */
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
};

/**
 * @description 取出本项目命名空间中签名相符的项目标记副本。schema 与当前版本相同时按当前结构完整校验；
 * 不同时只要求 schema 为非负整数，其余字段可能属于其他版本的结构，boot 只读取 sig 与 schema（判定 OURS_NEWER），
 * 这样较新版本改变标记结构时不会被误判为外来数据而失去 11.4 e 的保护。
 * @param root 已解析的根对象。
 * @param namespace 本项目命名空间的根键。
 * @param identity 装配配置的签名与 schema。
 * @returns 深冻结的标记副本；不存在、签名不符或不合法时为 null。
 */
const readMarker = (root: Record<string, unknown>, namespace: string,
  identity: MarkerIdentity): DeepReadonly<ProjectMarker> | null => {
  const data = Object.hasOwn(root, namespace) ? root[namespace] : undefined;
  const sys = isObject(data) && Object.hasOwn(data, 'sys') ? data.sys : undefined;
  if (!isObject(sys) || sys.sig !== identity.signature || !isCount(sys.schema)) return null;
  if (sys.schema === identity.schema && !checkMarker(sys, identity)) return null;
  // 解析结果一定是合法 JSON；复制隔离 heap 中的实时数据，冻结后供 boot 多次读取。
  return deepFreeze(copyJson(sys)) as unknown as DeepReadonly<ProjectMarker>;
};

/**
 * @description 由加载时的解析结果计算原始 Memory 概要（架构 11.3）。成本与根键数成正比，只读取项目标记，
 * 不遍历其他数据；每个 Memory 实例只调用一次。
 * @param root 原始文本的解析结果；空白文本由调用方按空对象传入。
 * @param namespace 本项目命名空间的根键。
 * @param identity 装配配置的签名与 schema。
 * @returns 深冻结的概要；根不是对象时为 UNPARSED_SUMMARY。
 */
export const summarize = (root: unknown, namespace: string, identity: MarkerIdentity): RawMemorySummary => {
  if (!isObject(root)) return UNPARSED_SUMMARY;
  const rootKeys = Object.keys(root);
  // EMPTY：没有键（含空白文本与 '{}'），或只有引擎默认键且值都是没有键的对象。
  const empty = rootKeys.every((key) => ENGINE_KEYS.has(key) && isObject(root[key])
    && Object.keys(root[key] as object).length === 0);
  return Object.freeze({ empty, parsed: true, rootKeys: Object.freeze(rootKeys),
    marker: readMarker(root, namespace, identity) });
};
