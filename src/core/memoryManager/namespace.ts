/**
 * 文件摘要：主 Memory 根命名空间的加载、深度校验与片段化序列化。
 *
 * 模块位置：core/memoryManager 的 Raw 后端基础层。createMemoryManager 在首次 begin
 * 调用 loadRawRoot 解析 RawMemory，随后用 createRawStore 维护"已提交文本片段"，
 * 使每 tick 只重新序列化变化的分区与目录，而不是整棵 Memory。
 *
 * 输入输出：输入是 RawMemory 的原始字符串、运行期对命名空间的原地修改，以及宿主
 * Memory 根对象；输出是下一次完整写入所需的 JSON 文本。片段只覆盖"我们拥有的"
 * 部分（allocations、migration、每个插件的 rawPartitions）；非托管根字段在写入时
 * 从宿主对象现取现序列化，既不缓存过期文本，也不会覆盖其他代码的数据。
 *
 * 数据安全约定：schema 版本、目录记录、迁移记录与 Raw 分区逐项深度校验，任一非法
 * 都抛错并由管理器进入故障状态（拒绝写入），避免遍历半损坏结构时才崩溃；旧
 * `leviathan` 命名空间只读取插件 payload 做一次性导入，绝不改写或删除。
 */
import type { JsonValue } from '@/contracts/memory';
import {
  LEGACY_NAMESPACE_KEY,
  NAMESPACE_KEY,
  NAMESPACE_SCHEMA_VERSION,
  type AllocationRecord,
  type MigrationMove,
  type MigrationRecord,
  type NamespaceV1,
} from './types';

/** 已解析的根对象与命名空间；namespace 与 root[NAMESPACE_KEY] 是同一引用。 */
export interface LoadedRoot {
  root: Record<string, unknown>;
  namespace: NamespaceV1;
  /** 除命名空间外的根字段名，序列化与状态诊断都要保留它们。 */
  preservedKeys: string[];
}

/** 只关心"是不是普通键值对象"；插件 payload 的深层合法性沿用 JSON 语义。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

/** 校验单条分配记录：后端必须是已知值，segment 必须带页号，raw 不得带页号。 */
const validateAllocation = (
  value: unknown,
  where: string
): AllocationRecord => {
  if (!isRecord(value)) throw new Error('Invalid allocation at ' + where);
  const { backend, segmentId, generation } = value;
  if (backend !== 'raw' && backend !== 'segment')
    throw new Error('Invalid allocation backend at ' + where);
  if (!isNonNegativeInteger(generation))
    throw new Error('Invalid allocation generation at ' + where);
  if (backend === 'segment') {
    if (!isNonNegativeInteger(segmentId))
      throw new Error('Invalid allocation segmentId at ' + where);
    return { backend, segmentId, generation };
  }
  if (segmentId !== undefined)
    throw new Error('Raw allocation must not carry segmentId at ' + where);
  return { backend, generation };
};

/** 校验 Raw 分区记录：dataVersion 非负整数，payload 允许任意 JSON 值。 */
const validateRawPartition = (
  value: unknown,
  where: string
): { dataVersion: number; payload: JsonValue } => {
  if (!isRecord(value)) throw new Error('Invalid raw partition at ' + where);
  if (!isNonNegativeInteger(value.dataVersion))
    throw new Error('Invalid dataVersion at ' + where);
  return {
    dataVersion: value.dataVersion,
    payload: value.payload as JsonValue,
  };
};

/** 校验一条搬迁计划；源与目标必须恰好各有一种后端，且页号与后端匹配。 */
const validateMove = (value: unknown, where: string): MigrationMove => {
  if (!isRecord(value)) throw new Error('Invalid migration move at ' + where);
  const {
    pluginId,
    localId,
    dataVersion,
    from,
    fromSegmentId,
    to,
    toSegmentId,
  } = value;
  if (typeof pluginId !== 'string' || typeof localId !== 'string')
    throw new Error('Invalid migration owner at ' + where);
  if (!isNonNegativeInteger(dataVersion))
    throw new Error('Invalid migration dataVersion at ' + where);
  if (
    (from !== 'raw' && from !== 'segment') ||
    (to !== 'raw' && to !== 'segment')
  )
    throw new Error('Invalid migration backend at ' + where);
  if (from === 'segment' && !isNonNegativeInteger(fromSegmentId))
    throw new Error('Migration source segment missing at ' + where);
  if (to === 'segment' && !isNonNegativeInteger(toSegmentId))
    throw new Error('Migration target segment missing at ' + where);
  return {
    pluginId,
    localId,
    dataVersion,
    from,
    fromSegmentId: from === 'segment' ? (fromSegmentId as number) : undefined,
    to,
    toSegmentId: to === 'segment' ? (toSegmentId as number) : undefined,
  };
};

/** 校验迁移记录；staged 只需是键值对象（内容由搬运算法写入）。 */
const validateMigration = (value: unknown): MigrationRecord | null => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error('Invalid migration record');
  if (!isNonNegativeInteger(value.generation))
    throw new Error('Invalid migration generation');
  if (
    value.phase !== 'copy' &&
    value.phase !== 'verify' &&
    value.phase !== 'switch'
  )
    throw new Error('Invalid migration phase');
  if (value.reason !== 'allocation' && value.reason !== 'preemption')
    throw new Error('Invalid migration reason');
  if (!Array.isArray(value.moves) || value.moves.length === 0)
    throw new Error('Invalid migration moves');
  if (!isRecord(value.staged)) throw new Error('Invalid migration staging');
  return {
    generation: value.generation,
    phase: value.phase,
    reason: value.reason,
    moves: value.moves.map((move, index) =>
      validateMove(move, 'moves[' + index + ']')
    ),
    staged: value.staged as Record<string, JsonValue>,
  };
};

/**
 * 深度校验命名空间。
 *
 * 不只检查顶层容器：目录里每条记录、Raw 分区、迁移计划都会逐项验证，任何非法形状
 * 立刻抛错。这样后续遍历不会在半损坏的数据结构上崩溃，也避免把错误数据当成有效
 * 分配继续使用。generationCounter 缺失按 0 处理（兼容尚无该字段的写入）。
 */
const validateNamespace = (value: unknown): NamespaceV1 => {
  if (!isRecord(value))
    throw new Error('Invalid MemoryManager namespace: not an object');
  if (value.schemaVersion !== NAMESPACE_SCHEMA_VERSION)
    throw new Error(
      'Unsupported MemoryManager schema: ' + String(value.schemaVersion)
    );
  if (!isRecord(value.allocations) || !isRecord(value.rawPartitions))
    throw new Error('Invalid MemoryManager namespace: bad partitions');
  const allocations: NamespaceV1['allocations'] = {};
  for (const [pluginId, bucket] of Object.entries(value.allocations)) {
    if (!isRecord(bucket))
      throw new Error('Invalid allocation bucket for ' + pluginId);
    allocations[pluginId] = {};
    for (const [localId, record] of Object.entries(bucket)) {
      allocations[pluginId][localId] = validateAllocation(
        record,
        pluginId + '/' + localId
      );
    }
  }
  const rawPartitions: NamespaceV1['rawPartitions'] = {};
  for (const [pluginId, bucket] of Object.entries(value.rawPartitions)) {
    if (!isRecord(bucket))
      throw new Error('Invalid raw partition bucket for ' + pluginId);
    rawPartitions[pluginId] = {};
    for (const [localId, record] of Object.entries(bucket)) {
      rawPartitions[pluginId][localId] = validateRawPartition(
        record,
        pluginId + '/' + localId
      );
    }
  }
  return {
    schemaVersion: NAMESPACE_SCHEMA_VERSION,
    generationCounter: isNonNegativeInteger(value.generationCounter)
      ? value.generationCounter
      : 0,
    allocations,
    rawPartitions,
    migration: validateMigration(value.migration),
  };
};

/** 创建空的版本 1 命名空间；首次使用或旧布局导入后由管理器填充。 */
export const createEmptyNamespace = (): NamespaceV1 => ({
  schemaVersion: NAMESPACE_SCHEMA_VERSION,
  generationCounter: 0,
  allocations: {},
  rawPartitions: {},
  migration: null,
});

/**
 * 从旧 `leviathan` 布局导入插件数据。
 *
 * 只读取 `leviathan.plugins[*]` 与 `leviathan.framework.pluginVersions[*]`，按
 * 原插件 ID 建立 Raw 分区，供同名模块以相同 version 重新申请时直接恢复；
 * Profiler 统计与插件健康表保留在旧命名空间不动（当前无消费者，删除反而丢数据）。
 * 导入结果不写回旧键，旧命名空间作为普通根字段原样保留，可随时回退。
 */
const importLegacy = (
  root: Record<string, unknown>,
  namespace: NamespaceV1
): boolean => {
  const legacy = root[LEGACY_NAMESPACE_KEY];
  if (!isRecord(legacy)) return false;
  const plugins = isRecord(legacy.plugins) ? legacy.plugins : {};
  const framework = isRecord(legacy.framework) ? legacy.framework : {};
  const versions = isRecord(framework.pluginVersions)
    ? framework.pluginVersions
    : {};
  let imported = false;
  for (const [pluginId, payload] of Object.entries(plugins)) {
    if (!isRecord(payload)) continue;
    const version = versions[pluginId];
    namespace.allocations[pluginId] = {
      main: { backend: 'raw', generation: 0 },
    };
    namespace.rawPartitions[pluginId] = {
      main: {
        // 版本缺失时写 0：applyVersion 把版本 0 当作新安装处理。
        dataVersion: Number.isInteger(version) ? (version as number) : 0,
        // 深拷贝：导入后的分区数据会被模块原地修改，共享引用会把旧命名空间一起改掉，
        // 违背"旧 leviathan 布局只读、可回退"的约定。数据来自 JSON.parse，往返安全。
        payload: JSON.parse(JSON.stringify(payload)) as JsonValue,
      },
    };
    imported = true;
  }
  return imported;
};

/**
 * 解析 RawMemory 文本并校验命名空间。
 *
 * 空字符串按空根处理（测试与首次运行）；解析失败、根不是对象、命名空间版本或任意
 * 记录形状不合法都会抛错——调用方据此进入故障状态，绝不写入，避免覆盖无法理解的
 * 数据。
 */
export const loadRawRoot = (text: string): LoadedRoot => {
  const parsed: unknown = JSON.parse(text === '' ? '{}' : text);
  if (!isRecord(parsed)) throw new Error('Invalid Memory root: not an object');
  const root = parsed;
  const existing = root[NAMESPACE_KEY];
  if (existing === undefined) {
    const namespace = createEmptyNamespace();
    importLegacy(root, namespace);
    root[NAMESPACE_KEY] = namespace;
    return {
      root,
      namespace,
      preservedKeys: Object.keys(root).filter((key) => key !== NAMESPACE_KEY),
    };
  }
  const namespace = validateNamespace(existing);
  return {
    root,
    namespace,
    preservedKeys: Object.keys(root).filter((key) => key !== NAMESPACE_KEY),
  };
};

/** 片段化的根写入器；所有 mark* 之后必须调用 serialize 才产生新文本。 */
export interface RawStore {
  root: Record<string, unknown>;
  namespace: NamespaceV1;
  /** 目录（allocations 或其内部记录）被原地修改。 */
  markAllocationsDirty(): void;
  /** migration journal 或代际计数器被修改。 */
  markMigrationDirty(): void;
  /** 某个插件的 Raw 分区被修改。 */
  markPluginDirty(pluginId: string): void;
  /**
   * 宿主 Memory 是否带来了新的根字段变化（O(根字段数) 次引用比较，不序列化）。
   * 只比较键集合与引用：深层原地修改不会被发现，约定外部代码替换根字段写入。
   */
  hasExternalChanges(external: Record<string, unknown> | null): boolean;
  /** 生成下一次完整写入文本；非托管根字段从 external 现取，缺省用解析时的快照。 */
  serialize(external?: Record<string, unknown> | null): string;
  /** 写入成功后推进外部基线，避免同一变化被反复判定为"待写"。 */
  commitExternal(external: Record<string, unknown> | null): void;
  /** 当前保留的非托管根字段名（只读快照）。 */
  preservedKeys(): string[];
}

/**
 * 创建片段写入器。
 *
 * 只缓存我们拥有的片段（allocations/migration/插件分区）；非托管根字段不缓存，
 * 每次写入时从宿主对象（若提供）或加载时的快照序列化，因此不会出现"外部改了字段、
 * 缓存仍是旧文本"的覆盖问题。
 */
export const createRawStore = (loaded: LoadedRoot): RawStore => {
  const { root, namespace } = loaded;
  const fragments = new Map<string, string>();

  const foreignKeys = (external: Record<string, unknown> | null): string[] => {
    const keys = new Set<string>();
    for (const key of Object.keys(root))
      if (key !== NAMESPACE_KEY) keys.add(key);
    if (external)
      for (const key of Object.keys(external))
        if (key !== NAMESPACE_KEY) keys.add(key);
    return [...keys];
  };

  const hasExternalChanges = (
    external: Record<string, unknown> | null
  ): boolean => {
    if (!external || external === root) return false;
    for (const key of foreignKeys(external))
      if (root[key] !== external[key]) return true;
    return false;
  };

  const serialize = (external?: Record<string, unknown> | null): string => {
    const entries: string[] = [];
    for (const key of foreignKeys(external)) {
      const value = external && key in external ? external[key] : root[key];
      entries.push(JSON.stringify(key) + ':' + JSON.stringify(value));
    }
    const allocations =
      fragments.get('allocations') ?? JSON.stringify(namespace.allocations);
    fragments.set('allocations', allocations);
    const migration =
      fragments.get('migration') ?? JSON.stringify(namespace.migration);
    fragments.set('migration', migration);
    const pluginEntries: string[] = [];
    for (const [pluginId, partitions] of Object.entries(
      namespace.rawPartitions
    )) {
      const fragment =
        fragments.get('plugin:' + pluginId) ?? JSON.stringify(partitions);
      fragments.set('plugin:' + pluginId, fragment);
      pluginEntries.push(JSON.stringify(pluginId) + ':' + fragment);
    }
    entries.push(
      JSON.stringify(NAMESPACE_KEY) +
        ':{' +
        '"schemaVersion":' +
        NAMESPACE_SCHEMA_VERSION +
        ',"generationCounter":' +
        namespace.generationCounter +
        ',"allocations":' +
        allocations +
        ',"rawPartitions":{' +
        pluginEntries.join(',') +
        '},"migration":' +
        migration +
        '}'
    );
    return '{' + entries.join(',') + '}';
  };

  const commitExternal = (external: Record<string, unknown> | null): void => {
    if (!external || external === root) return;
    for (const key of foreignKeys(external))
      if (key in external) root[key] = external[key];
  };

  return {
    root,
    namespace,
    markAllocationsDirty: () => {
      fragments.delete('allocations');
    },
    markMigrationDirty: () => {
      fragments.delete('migration');
    },
    markPluginDirty: (pluginId) => {
      fragments.delete('plugin:' + pluginId);
    },
    hasExternalChanges,
    serialize,
    commitExternal,
    preservedKeys: () =>
      Object.keys(root).filter((key) => key !== NAMESPACE_KEY),
  };
};
