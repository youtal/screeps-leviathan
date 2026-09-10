/**
 * 文件摘要：实现 Framework 的常驻 Memory、显式标脏和分层提交。
 * 每个实例只在首次挂载时解析 RawMemory；插件通过 query/commit 访问声明过的持久分区。
 * critical 分区当 tick 提交，checkpoint 分区按间隔提交；未声明持久化的插件不创建分区。
 * dirty 分区使用原生 JSON.stringify，clean 分区复用字符串片段，避免遍历完整 Memory 树。
 */
import type { ProfilerMemory } from '../profiler';
import type {
  DeepReadonly,
  FrameworkMemory,
  FrameworkState,
  JsonValue,
  LeviathanPlugin,
  MemoryPort,
  PersistenceLayer,
  PersistenceNamespace,
} from './types';
import { createMemoryFragments } from './memoryFragments';

/** Screeps 的开放 Memory 接口由业务声明扩展；内核只额外要求自己的可选根命名空间。 */
type RootMemory = Memory & { leviathan?: FrameworkMemory };

/** 每个持久插件对应一个调度分区；value 始终引用 Memory.leviathan.plugins[id]。 */
interface Partition {
  layer: PersistenceLayer;
  checkpointInterval: number;
  value: JsonValue;
  dirty: boolean;
  dirtySince?: number;
  forceCommit: boolean;
}

/** 原型相关键不能作为命名空间，防止普通对象的继承属性被误认成插件数据。 */
export const validId = (id: string): boolean =>
  typeof id === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) &&
  id !== 'prototype' &&
  !Object.prototype.hasOwnProperty.call(Object.prototype, id);

/** 只验证 Framework 自己依赖的容器形状；插件键值内容遵循原生 Memory 语义。 */
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 读取并验证插件持久化声明；未声明表示该插件只使用自己的闭包状态。 */
const persistence = (plugin: LeviathanPlugin) => {
  const config = plugin.manifest.persistence;
  if (!config) return undefined;
  const interval = config.checkpointInterval ?? 100;
  if (
    !['critical', 'checkpoint'].includes(config.layer) ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    (config.layer !== 'checkpoint' && config.checkpointInterval !== undefined)
  )
    throw new Error('Invalid persistence config: ' + plugin.manifest.id);
  return { layer: config.layer, checkpointInterval: interval };
};

/**
 * 创建实例级持久化管理器。首次 begin 延迟解析，使加载错误仍经过 Kernel 边界；
 * 之后只挂载同一个 heap 根，不再读取 RawMemory。公开插件能力由 namespace 返回，
 * begin/flush/framework/profiler 都是 Framework 内核生命周期使用的内部端口。
 */
export const createMemoryInterceptor = (
  port: MemoryPort,
  profilerCheckpointInterval = 100
) => {
  if (
    !Number.isInteger(profilerCheckpointInterval) ||
    profilerCheckpointInterval < 1
  )
    throw new Error('Invalid profiler checkpoint interval');

  let cached: RootMemory | undefined;
  let loaded = false;
  let loadFailed = false;
  let loadFailure: unknown;
  let writable = false;
  let currentTick = -1;

  /** 字符串片段管理器在首次解析后创建，生命周期与 cached 根一致。 */
  let fragments: ReturnType<typeof createMemoryFragments> | undefined;

  const partitions = new Map<string, Partition>();
  let frameworkDirty = false;
  let profilerDirty = false;
  let profilerDirtySince: number | undefined;

  const state = (): FrameworkState => {
    if (!cached?.leviathan) throw new Error('Framework Memory is not mounted');
    return cached.leviathan.framework;
  };

  /** 首次标脏时记录 tick；连续提交不会把 checkpoint 的截止时间向后推迟。 */
  const mark = (partition: Partition): void => {
    if (!partition.dirty) partition.dirtySince = currentTick;
    partition.dirty = true;
  };

  /** 创建版本 1 根命名空间；框架健康状态和 Profiler 即使没有业务分区也需要该容器。 */
  const ensureFrameworkMemory = (): FrameworkMemory => {
    if (!cached!.leviathan) {
      cached!.leviathan = {
        schemaVersion: 1,
        framework: {
          pluginVersions: {},
          pluginHealth: {},
          intentReceipts: [],
          profiler: {},
        },
        plugins: {},
      };
      frameworkDirty = true;
    }
    return cached!.leviathan;
  };

  /**
   * 挂载根对象并处理显式声明持久化的插件。迁移直接接收当前键值对象，行为接近直接
   * 操作 Memory：返回值必须是对象；若迁移在抛错前原地修改旧值，内核不额外深克隆回滚。
   * 原始 RawMemory 只有在 flush 成功后才变化，global reset 仍能恢复最后一次提交值。
   */
  const begin = (plugins: readonly LeviathanPlugin[], tick: number): void => {
    writable = false;
    currentTick = tick;
    if (loadFailed) throw loadFailure;
    if (!loaded) {
      loaded = true;
      try {
        const parsed: unknown = JSON.parse(port.read() || '{}');
        if (!object(parsed)) throw new Error('Invalid Memory root');
        cached = parsed as RootMemory;
        const existing = cached.leviathan;
        if (
          existing !== undefined &&
          (!object(existing) ||
            existing.schemaVersion !== 1 ||
            !object(existing.framework) ||
            !object(existing.plugins) ||
            !object(existing.framework.pluginVersions) ||
            !object(existing.framework.pluginHealth) ||
            !object(existing.framework.profiler) ||
            !Array.isArray(existing.framework.intentReceipts))
        )
          throw new Error('Invalid or unsupported leviathan Memory schema');
        fragments = createMemoryFragments(cached);
      } catch (error) {
        loadFailed = true;
        loadFailure = error;
        throw error;
      }
    }

    const memory = ensureFrameworkMemory();
    for (const plugin of plugins) {
      const id = plugin.manifest.id;
      const config = persistence(plugin);
      const known = partitions.get(id);
      if (!config) {
        if (known)
          throw new Error('Cannot remove persistence at runtime: ' + id);
        continue;
      }
      if (known && known.layer !== config.layer)
        throw new Error('Cannot change persistence layer at runtime: ' + id);

      const version = plugin.manifest.version;
      const previous = memory.framework.pluginVersions[id] ?? 0;
      if (!Number.isInteger(previous) || previous < 0 || previous > version)
        throw new Error('Unsupported plugin version: ' + id);

      let migrated = false;
      if (previous === version) {
        if (!Object.prototype.hasOwnProperty.call(memory.plugins, id))
          throw new Error('Missing plugin Memory: ' + id);
      } else {
        if (previous > 0 && !plugin.migrate)
          throw new Error('Missing migration: ' + id);
        const old = memory.plugins[id] ?? {};
        if (!object(old))
          throw new Error('Plugin Memory must be a key-value object: ' + id);
        // object 守卫已在运行时排除数组；断言用于消除递归 JsonValue 联合中的数组分支。
        const value = plugin.migrate
          ? plugin.migrate(old as Record<string, JsonValue>, previous)
          : {};
        if (!object(value))
          throw new Error('Plugin Memory must be a key-value object: ' + id);
        memory.plugins[id] = value;
        memory.framework.pluginVersions[id] = version;
        frameworkDirty = true;
        migrated = true;
      }
      if (!object(memory.plugins[id]))
        throw new Error('Plugin Memory must be a key-value object: ' + id);

      const partition: Partition = known ?? {
        ...config,
        value: memory.plugins[id],
        dirty: false,
        forceCommit: false,
      };
      partition.checkpointInterval = config.checkpointInterval;
      partition.value = memory.plugins[id];
      if (migrated) {
        mark(partition);
        partition.forceCommit = true;
      }
      partitions.set(id, partition);
    }

    port.mount(cached!);
    writable = true;
  };

  /**
   * 创建插件唯一的公开 Memory 能力。query 只读；commit 在回调前标脏并返回回调结果。
   * 未在 manifest 声明 persistence 的插件只有在误调用时才报错，不会创建空分区。
   */
  const namespace = <M extends object>(id: string): PersistenceNamespace<M> => {
    const get = (): Partition => {
      const partition = partitions.get(id);
      if (!partition)
        throw new Error('Plugin has no persistence declaration: ' + id);
      return partition;
    };
    return {
      query: () => get().value as unknown as DeepReadonly<M>,
      commit: <R>(mutator: (memory: M) => R): R => {
        const partition = get();
        mark(partition);
        return mutator(partition.value as unknown as M);
      },
    };
  };

  /** Framework 关键状态的内部端口；失败和熔断变化采用 critical 提交语义。 */
  const framework = {
    query: state,
    commit: <R>(mutator: (memory: FrameworkState) => R): R => {
      frameworkDirty = true;
      return mutator(state());
    },
  };

  /** Profiler 的内部端口；访问器先 markDirty，再原地累计样本。 */
  const profiler = {
    query: (): ProfilerMemory => state().profiler,
    markDirty: (): void => {
      if (!profilerDirty) profilerDirtySince = currentTick;
      profilerDirty = true;
    },
  };

  /**
   * 提交到期 dirty 分区。先在局部变量生成片段，完整写入成功后才清 dirty；
   * 原生 stringify 或存储端口抛错时保留重试条件。返回值表示是否实际写入。
   */
  const flush = (tick: number): boolean => {
    if (!writable) return false;
    try {
      const committed: Partition[] = [];
      const profilerDue =
        profilerDirty &&
        profilerDirtySince !== undefined &&
        tick - profilerDirtySince >= profilerCheckpointInterval - 1;
      let changed = false;

      if (frameworkDirty || profilerDue) changed = true;
      const pluginChanges = new Map<string, unknown>();
      for (const [id, partition] of partitions) {
        if (!partition.dirty) continue;
        const due =
          partition.forceCommit ||
          partition.layer === 'critical' ||
          (partition.dirtySince !== undefined &&
            tick - partition.dirtySince >= partition.checkpointInterval - 1);
        if (!due) continue;
        pluginChanges.set(id, partition.value);
        committed.push(partition);
        changed = true;
      }
      if (!changed) return false;

      const prepared = fragments!.prepare({
        framework: frameworkDirty ? state() : undefined,
        profiler: profilerDue ? state().profiler : undefined,
        plugins: pluginChanges,
      });
      port.write(prepared.value);
      prepared.accept();
      frameworkDirty = false;
      if (profilerDue) {
        profilerDirty = false;
        profilerDirtySince = undefined;
      }
      for (const partition of committed) {
        partition.dirty = false;
        partition.dirtySince = undefined;
        partition.forceCommit = false;
      }
      return true;
    } finally {
      writable = false;
    }
  };

  return { begin, flush, namespace, framework, profiler };
};
