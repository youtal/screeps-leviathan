/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的主存储格式装载层，只在 global 首次 begin 时运行一次。
 *
 * 主要功能：解析主存储文本，按设计 §8 的兼容协议识别 schemaVersion 2、转换 schemaVersion 1、
 * 在缺少命名空间时导入旧 leviathan 插件数据；输出每个分区记录的 JSON 片段基线、非托管根字段的
 * 片段前缀、结构变化标记及诊断。
 *
 * 实现过程：JSON.parse 整个文本后逐层校验容器结构；每条记录立即重新编码为
 * `{"dataVersion":N,"payload":...}` 片段，非托管根字段编码为 `"key":value,` 前缀。之后不再
 * 持有解析出的对象——未申请分区只保留片段字符串，申请时再从片段解析出隔离副本。
 *
 * 技术要点：只接受可安全理解的结构，否则抛错由管理器锁定装载故障、保护原文本不被覆盖。
 * 历史 payload 可以是任意 JSON 值（数组、null、基本值或尚不满足受管约束的对象），装载只保证
 * 其无损保留；是否可发布访问器由申请时的校验决定。Segment 归属的身份被忽略且不读取任何页面。
 * 一次性成本：一次整体解析 + 每条记录与每个根字段各一次编码；global 内不再重复。
 */
import {
  LEGACY_NAMESPACE_KEY,
  NAMESPACE_KEY,
  NAMESPACE_SCHEMA_VERSION,
} from './types';
import { isPlainObject, isReservedKey } from './validate';

/** 装载得到的一条分区记录：只保留版本与编码后的片段。 */
export interface StoredRecord {
  owner: string;
  localId: string;
  dataVersion: number;
  /** `{"dataVersion":N,"payload":...}` 的 JSON 文本，即已提交基线。 */
  fragment: string;
}

export interface LoadedStore {
  /** 非托管根字段拼成的前缀，形如 `"a":1,"b":{...},`；没有时为空串。 */
  foreignPrefix: string;
  preservedKeys: string[];
  records: StoredRecord[];
  /** 格式转换或导入产生了需要写出的结构变化。 */
  structureChanged: boolean;
  ignoredSegmentPartitions: { owner: string; localId: string }[];
  warnings: string[];
}

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** 身份键在装载时只要求非空且不是原型保留键；是否可申请由 apply 的更严格规则决定。 */
const isLoadableKey = (key: string): boolean => key !== '' && !isReservedKey(key);

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/** 编码一条记录片段；payload 来自 JSON.parse，必然可编码。 */
export const encodeRecord = (dataVersion: number, payload: unknown): string =>
  '{"dataVersion":' + dataVersion + ',"payload":' + JSON.stringify(payload) + '}';

/** 校验并取出一条记录的版本与 payload；缺字段或多余字段都视为无法安全理解。 */
const readRecord = (
  value: unknown,
  where: string
): { dataVersion: number; payload: unknown } => {
  if (!isPlainObject(value)) throw new Error('Invalid partition record at ' + where);
  if (!isNonNegativeInteger(value.dataVersion))
    throw new Error('Invalid dataVersion at ' + where);
  if (!hasOwn(value, 'payload')) throw new Error('Missing payload at ' + where);
  for (const key of Object.keys(value))
    if (key !== 'dataVersion' && key !== 'payload')
      throw new Error('Unknown record field ' + key + ' at ' + where);
  return { dataVersion: value.dataVersion, payload: value.payload };
};

/** 遍历两级 owner → localId 容器，逐项回调；身份键不合法视为结构损坏。 */
const forEachIdentity = (
  container: unknown,
  what: string,
  visit: (owner: string, localId: string, value: unknown) => void
): void => {
  if (!isPlainObject(container)) throw new Error('Invalid MemoryManager ' + what);
  for (const [owner, bucket] of Object.entries(container)) {
    if (!isLoadableKey(owner)) throw new Error('Invalid ' + what + ' owner: ' + owner);
    if (!isPlainObject(bucket)) throw new Error('Invalid ' + what + ' bucket for ' + owner);
    for (const [localId, value] of Object.entries(bucket)) {
      if (!isLoadableKey(localId))
        throw new Error('Invalid ' + what + ' key: ' + owner + '/' + localId);
      visit(owner, localId, value);
    }
  }
};

const loadV2 = (namespace: Record<string, unknown>): StoredRecord[] => {
  for (const key of Object.keys(namespace))
    if (key !== 'schemaVersion' && key !== 'partitions')
      throw new Error('Unknown MemoryManager namespace field: ' + key);
  const records: StoredRecord[] = [];
  forEachIdentity(namespace.partitions, 'partitions', (owner, localId, value) => {
    const { dataVersion, payload } = readRecord(value, owner + '/' + localId);
    records.push({ owner, localId, dataVersion, fragment: encodeRecord(dataVersion, payload) });
  });
  return records;
};

/**
 * schemaVersion 1 转换：以 allocations 的正式归属为准。raw 归属必须有对应 Raw 记录，
 * 否则报装载错误（不能当作首次安装）；segment 归属连同同身份的残留 Raw 副本一起忽略；
 * 没有正式归属的孤立 Raw 记录与 migration/generationCounter 等字段不进入目标格式。
 */
const loadV1 = (
  namespace: Record<string, unknown>,
  ignored: { owner: string; localId: string }[]
): StoredRecord[] => {
  const raw = namespace.rawPartitions;
  if (!isPlainObject(raw)) throw new Error('Invalid MemoryManager rawPartitions');
  const records: StoredRecord[] = [];
  forEachIdentity(namespace.allocations, 'allocations', (owner, localId, allocation) => {
    if (!isPlainObject(allocation))
      throw new Error('Invalid allocation at ' + owner + '/' + localId);
    if (allocation.backend === 'segment') {
      ignored.push({ owner, localId });
      return;
    }
    if (allocation.backend !== 'raw')
      throw new Error('Invalid allocation backend at ' + owner + '/' + localId);
    const bucket = raw[owner];
    const value =
      isPlainObject(bucket) && hasOwn(bucket, localId) ? bucket[localId] : undefined;
    if (value === undefined)
      throw new Error('Missing raw partition for allocation ' + owner + '/' + localId);
    const { dataVersion, payload } = readRecord(value, owner + '/' + localId);
    records.push({ owner, localId, dataVersion, fragment: encodeRecord(dataVersion, payload) });
  });
  return records;
};

/**
 * 旧 leviathan 布局导入：plugins 下的对象数据按 owner/main 建立记录，版本取
 * framework.pluginVersions，缺失或非法记 0（要求业务 migrate）。片段在此刻编码，
 * 与保留的 leviathan 根字段片段互不共享可变对象。
 */
const importLegacy = (legacy: unknown, warnings: string[]): StoredRecord[] => {
  if (!isPlainObject(legacy)) return [];
  const plugins = isPlainObject(legacy.plugins) ? legacy.plugins : {};
  const framework = isPlainObject(legacy.framework) ? legacy.framework : {};
  const versions = isPlainObject(framework.pluginVersions) ? framework.pluginVersions : {};
  const records: StoredRecord[] = [];
  for (const [owner, payload] of Object.entries(plugins)) {
    if (!isPlainObject(payload)) continue;
    if (!isLoadableKey(owner)) {
      warnings.push('legacy import skipped unsafe key: ' + owner);
      continue;
    }
    const version = hasOwn(versions, owner) ? versions[owner] : undefined;
    const dataVersion = isNonNegativeInteger(version) ? version : 0;
    records.push({
      owner,
      localId: 'main',
      dataVersion,
      fragment: encodeRecord(dataVersion, payload),
    });
  }
  return records;
};

/**
 * 装载主存储文本。空文本视为空根；坏 JSON、根不是对象、未知 schemaVersion 或无法理解的
 * 结构都抛错，调用方据此锁定装载故障且不写回。
 */
export const loadStore = (text: string): LoadedStore => {
  const parsed: unknown = JSON.parse(text === '' ? '{}' : text);
  if (!isPlainObject(parsed)) throw new Error('Invalid Memory root: not an object');
  const warnings: string[] = [];
  const ignoredSegmentPartitions: { owner: string; localId: string }[] = [];
  const namespace = hasOwn(parsed, NAMESPACE_KEY) ? parsed[NAMESPACE_KEY] : undefined;
  let records: StoredRecord[];
  let structureChanged: boolean;
  if (namespace === undefined) {
    records = importLegacy(parsed[LEGACY_NAMESPACE_KEY], warnings);
    structureChanged = records.length > 0;
  } else {
    if (!isPlainObject(namespace))
      throw new Error('Invalid MemoryManager namespace: not an object');
    const version = namespace.schemaVersion;
    if (version === NAMESPACE_SCHEMA_VERSION) {
      records = loadV2(namespace);
      structureChanged = false;
    } else if (version === 1) {
      records = loadV1(namespace, ignoredSegmentPartitions);
      structureChanged = true;
    } else {
      throw new Error('Unsupported MemoryManager schema: ' + String(version));
    }
  }
  const preservedKeys = Object.keys(parsed).filter((key) => key !== NAMESPACE_KEY);
  let foreignPrefix = '';
  for (const key of preservedKeys)
    foreignPrefix += JSON.stringify(key) + ':' + JSON.stringify(parsed[key]) + ',';
  if (ignoredSegmentPartitions.length)
    warnings.push(
      'ignored segment partitions: ' +
        ignoredSegmentPartitions.map((id) => id.owner + '/' + id.localId).join(', ')
    );
  return {
    foreignPrefix,
    preservedKeys,
    records,
    structureChanged,
    ignoredSegmentPartitions,
    warnings,
  };
};
