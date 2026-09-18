/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的主实现，统一协调分区申请、存储读写、Segment 分配和恢复。
 *
 * 主要功能：提供按 owner 绑定的申请入口、pending/ready 访问器、tick 生命周期及状态诊断，
 * 支持初始化、数据版本迁移、关键数据提交和按间隔保存的检查点。
 *
 * 实现过程：begin 加载目录并观察 Segment，申请时匹配或创建分区；启动申请窗口结束后按优先级分配，
 * 用迁移记录逐步完成复制、校验、切换和清理，end 推进迁移并提交需要保存的数据。
 *
 * 技术要点：namespace 负责主存储解析与序列化，segments 校验页面身份，platform 执行宿主访问。
 * 分区对象与脏标记跨 tick 保存在实例内存；ready 视图会检查 tick 和数据引用，禁止继续使用过期视图。
 * global reset 后根据持久目录与迁移记录恢复，未就绪分区返回 pending，外来 Segment 内容不会被直接覆盖。
 */
import type {
  ApplyMemoryAccessor,
  DeepReadonly,
  JsonValue,
  MemoryAccess,
  MemoryAccessor,
  MemoryApplicationOptions,
  MemoryHost,
  MemoryPendingReason,
  PersistenceLayer,
} from '@/contracts/memory';
import type { LoggerFactory } from '@/contracts/logging';
import { createRawStore, loadRawRoot, type RawStore } from './namespace';
import {
  createEnvelope,
  describeMismatch,
  encodeEnvelope,
  parseEnvelope,
} from './segments';
import { createScreepsPlatform } from './platform';
import {
  SEGMENT_IDS,
  type AllocationRecord,
  type Backend,
  type MemoryManagerStatus,
  type MemoryPlatform,
  type MigrationMove,
  type PartitionPending,
  type SegmentEnvelope,
} from './types';

/** 申请与访问期间出现的配置错误：必须直接抛出，不能伪装成 pending。 */
const configError = (message: string): Error =>
  new Error('MemoryManager: ' + message);

/** 局部 ID 与归属键的稳定性校验：拒绝原型相关键与空串，避免把继承属性当数据。 */
const isStableKey = (value: string): boolean =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
  value !== 'prototype' &&
  value !== 'constructor' &&
  !Object.prototype.hasOwnProperty.call(Object.prototype, value);

/** 解析后的申请配置；申请时校验一次，运行期不再读取调用方对象。 */
interface AppliedOptions {
  version: number;
  layer: PersistenceLayer;
  checkpointInterval: number;
  priority?: number;
  initialize: () => object;
  migrate?: (memory: unknown, fromVersion: number) => object;
}

/** 一个逻辑分区：目录决定位置，heap 持有事实源数据，dirty 决定是否回写。 */
interface Partition {
  pluginId: string;
  localId: string;
  options: AppliedOptions;
  generation: number;
  backend: Backend;
  segmentId?: number;
  /**
   * heap 事实源；仅在"尚未装载"（首次 apply 前、页未激活、恢复失败）时为 null。
   * 迁移冻结只设置 pending，数据仍在内存中但不可访问（accessor 返回 pending）。
   */
  data: Record<string, JsonValue> | null;
  dataVersion: number;
  dirty: boolean;
  dirtySince?: number;
  forceCommit: boolean;
  pending: PartitionPending | null;
  writeError: string | null;
  /** 最近一次已上报的写入错误：同一消息只记录一次，避免每 tick 刷屏。 */
  lastLoggedError: string | null;
  accessor: MemoryAccessor<any> | null;
}

export interface MemoryManagerOptions {
  /**
   * Runtime 先创建的日志工厂。该依赖必须显式提供，MemoryManager 不导入同级实现，
   * 从而保证 Core 模块的依赖方向只由组合根决定。
   */
  logging: LoggerFactory;
  /** 平台端口；缺省直连 Screeps RawMemory/Segment。 */
  platform?: MemoryPlatform;
  /**
   * 读取宿主 Memory 根对象的访问器，用于合并其他代码写入的根字段。
   *
   * 缺省不读取全局 `Memory`：Screeps 的 `Memory` 是惰性 getter，读一次会触发引擎
   * 再解析一遍 RawMemory，等于把整棵 Memory 树在 heap 里存两份。按访问边界规范，
   * 项目内代码也不应绕开本模块写 Memory，因此默认只保留解析时的根字段快照；
   * 确有宿主需要合并运行期外部写入时，再显式注入本访问器。
   */
  getHostMemory?: () => Record<string, unknown> | undefined;
  /** 可用页列表；缺省固定 0..9，仅测试需要覆盖。 */
  segmentIds?: readonly number[];
  /** 启动窗口最多被延后的 tick 数；超过后强制封存（迟到的申请改用主 Memory）。 */
  maxStartupDeferrals?: number;
  /** 等待页可见的最长 tick 数；超过仍未观察到全部页时放弃 Segment 分配。 */
  maxObservationTicks?: number;
}

/** 管理器对外能力：MemoryHost 生命周期 + 诊断快照。 */
export interface MemoryManager extends MemoryHost {
  getStatus(): MemoryManagerStatus;
}

export const createMemoryManager = (
  options: MemoryManagerOptions
): MemoryManager => {
  const platform = options.platform ?? createScreepsPlatform();
  const segmentIds = options.segmentIds ?? SEGMENT_IDS;
  const maxStartupDeferrals = options.maxStartupDeferrals ?? 10;
  const maxObservationTicks = options.maxObservationTicks ?? 5;
  const getHostMemory = options.getHostMemory ?? (() => undefined);

  /** 作用域日志器：固定名称、每实例一份；日志失败由 Logger 自身吞掉，不影响存储流程。 */
  const log = options.logging.scope('MemoryManager');

  const partitions = new Map<string, Partition>();
  let store: RawStore | null = null;
  let loaded = false;
  let fault: string | null = null;
  let currentTick = -1;
  let startupWindowOpen = true;
  let startupWindowForced = false;
  let startupDeferrals = 0;
  let deferredThisTick = false;
  let rawDirty = false;
  let allocationPlanned = false;
  /** 最近一次分配规划中被排除的候选及原因：只做诊断，不影响数据。 */
  let allocationSkipped: {
    pluginId: string;
    localId: string;
    reason: string;
  }[] = [];
  let observationSinceTick = -1;
  /**
   * 本 global 观察到的页内容快照：只记录"已经激活并读到内容"的页。
   * 未出现在这里的页不可写入——没有读过内容就无法断定它不是别人正在使用的页。
   */
  const observedSegments = new Map<number, string>();
  /** 被外部数据或未认领信封占用的页：不参与分配、不会被写入。 */
  const reservedSegments = new Map<number, string>();
  /** 清理阶段的重试计数（journal 代际 → 次数）：只驻留 heap，不进入存储。 */
  const cleanupAttempts = new Map<number, number>();
  /**
   * 当前 journal 状态（含新目录）是否已经随主 Memory 成功落盘。
   * 只有为真才允许清空被腾退的页：否则主 Memory 写失败 + global reset 会留下
   * "存储目录仍指向已清空页"的悬空引用。加载到的 journal 视为已落盘。
   */
  let migrationPersisted = false;
  /**
   * 待执行搬迁队列：窗口封存后一次性排好（先腾退、再迁入），执行阶段串行推进，
   * 保证同一时刻至多一个 journal 记录，避免相互覆盖的中间态。
   */
  const moveQueue: MigrationMove[] = [];

  const key = (pluginId: string, localId: string): string =>
    pluginId + '/' + localId;

  const allocationOf = (
    pluginId: string,
    localId: string
  ): AllocationRecord | undefined =>
    store?.namespace.allocations[pluginId]?.[localId];

  const rawRecordOf = (
    pluginId: string,
    localId: string
  ): { dataVersion: number; payload: JsonValue } | undefined =>
    store?.namespace.rawPartitions[pluginId]?.[localId];

  /** 把分区标记为等待；等待不计数失败，模块应只跳过依赖 Memory 的行为。 */
  const setPending = (
    partition: Partition,
    reason: MemoryPendingReason,
    retryAt = currentTick + 1
  ): void => {
    // pending 往返属于高频细节，只走 debug（默认关闭），供排查时开启。
    if (partition.pending?.reason !== reason)
      log.debug(
        'partition ' +
          key(partition.pluginId, partition.localId) +
          ' pending: ' +
          reason
      );
    partition.pending = { reason, retryAt };
  };

  const clearPending = (partition: Partition): void => {
    if (partition.pending)
      log.debug(
        'partition ' +
          key(partition.pluginId, partition.localId) +
          ' ready again'
      );
    partition.pending = null;
  };

  /** 目录写入统一走这里，确保 allocations 片段失效。 */
  const writeAllocation = (
    pluginId: string,
    localId: string,
    record: AllocationRecord
  ): void => {
    store!.namespace.allocations[pluginId] ??= {};
    store!.namespace.allocations[pluginId][localId] = record;
    store!.markAllocationsDirty();
    rawDirty = true;
  };

  const writeRawPartition = (
    pluginId: string,
    localId: string,
    dataVersion: number,
    payload: JsonValue
  ): void => {
    store!.namespace.rawPartitions[pluginId] ??= {};
    store!.namespace.rawPartitions[pluginId][localId] = {
      dataVersion,
      payload,
    };
    store!.markPluginDirty(pluginId);
    rawDirty = true;
  };

  const deleteRawPartition = (pluginId: string, localId: string): void => {
    const bucket = store!.namespace.rawPartitions[pluginId];
    if (!bucket || !(localId in bucket)) return;
    delete bucket[localId];
    if (Object.keys(bucket).length === 0)
      delete store!.namespace.rawPartitions[pluginId];
    store!.markPluginDirty(pluginId);
    rawDirty = true;
  };

  const segmentsVisible = (): Record<number, string> => platform.readSegments();

  /**
   * 请求激活固定页集合。
   *
   * MemoryManager 排他占用这 10 页：请求的是精确集合，而不是与外部活动页取并集，
   * 否则叠加外部页会超过 Screeps 单 tick 最多 10 页的限制。外部工具不应与本模块
   * 同时使用这些页；其残留数据会被识别为保留页并跳过。
   */
  const ensureSegmentsActive = (): void => {
    const visible = new Set(platform.activeSegments());
    if (segmentIds.some((id) => !visible.has(id)))
      platform.activateSegments([...segmentIds]);
  };

  /** 页内容是否属于本管理器的既有分配或进行中的迁移。 */
  const pageBelongsToUs = (id: number, envelope: SegmentEnvelope): boolean => {
    const allocation = allocationOf(
      envelope.owner.pluginId,
      envelope.owner.localId
    );
    if (allocation?.backend === 'segment' && allocation.segmentId === id)
      return true;
    const journal = store?.namespace.migration;
    if (journal)
      for (const move of journal.moves)
        if (move.toSegmentId === id || move.fromSegmentId === id) return true;
    return false;
  };

  /**
   * 刷新页内容观察结果。
   *
   * 空页可用；属于我们目录/journal 的页保留；其他任何内容（外部工具数据、没有目录
   * 归属的历史信封）都登记为保留页，绝不写入。只有观察过的页才允许分配。
   */
  const refreshObservations = (): void => {
    const visible = segmentsVisible();
    for (const id of segmentIds) {
      if (visible[id] === undefined) continue;
      const text = visible[id] ?? '';
      observedSegments.set(id, text);
      if (text === '') {
        reservedSegments.delete(id);
        continue;
      }
      const envelope = parseEnvelope(text);
      if (envelope && pageBelongsToUs(id, envelope)) {
        reservedSegments.delete(id);
        continue;
      }
      const reason = envelope
        ? 'unclaimed envelope ' +
          envelope.owner.pluginId +
          '/' +
          envelope.owner.localId
        : 'foreign content';
      // 只在页首次被保留或原因变化时告警，避免每 tick 重复输出。
      if (reservedSegments.get(id) !== reason) {
        reservedSegments.set(id, reason);
        log.warn('segment ' + id + ' reserved: ' + reason);
      }
    }
  };

  const unobservedSegments = (): number[] =>
    segmentIds.filter((id) => !observedSegments.has(id));

  /** 可分配页：观察过、内容为空，且未被保留。 */
  const pageAvailable = (id: number): boolean =>
    observedSegments.get(id) === '' && !reservedSegments.has(id);

  /**
   * 从后端恢复分区数据。
   *
   * 返回错误描述表示数据不可用（损坏、归属不符、降级），调用方据此设置
   * pending('recovery') 并保留诊断；返回 pending 表示只是还没就绪（页未激活）。
   */
  const restorePartition = (
    partition: Partition
  ):
    | { ok: true }
    | { ok: false; reason: MemoryPendingReason; error?: string } => {
    const { pluginId, localId } = partition;
    // 已装载的分区以 heap 为事实源：重试只服务"缺数据"的分区，
    // 绝不能用存储里的旧内容覆盖内存中尚未提交的修改。
    if (partition.data !== null) return { ok: true };
    if (partition.backend === 'raw') {
      const record = rawRecordOf(pluginId, localId);
      if (!record)
        return {
          ok: false,
          reason: 'recovery',
          error: 'missing raw partition',
        };
      partition.dataVersion = record.dataVersion;
      partition.data = record.payload as Record<string, JsonValue>;
      return { ok: true };
    }
    const segmentId = partition.segmentId;
    if (segmentId === undefined)
      return { ok: false, reason: 'recovery', error: 'missing segment id' };
    // 目录/journal 引用本实例不管理的页时不能无限等待：直接给出可诊断的错误。
    if (!segmentIds.includes(segmentId))
      return {
        ok: false,
        reason: 'recovery',
        error: 'segment ' + segmentId + ' is not managed by this instance',
      };
    const text = segmentsVisible()[segmentId];
    if (text === undefined) return { ok: false, reason: 'segment-activating' };
    const envelope = parseEnvelope(text);
    // 从目录恢复时只校验归属与代际：数据版本以信封为准，避免拿未读取的默认值比较。
    const mismatch = describeMismatch(
      envelope,
      { pluginId, localId },
      partition.generation
    );
    if (mismatch) return { ok: false, reason: 'recovery', error: mismatch };
    partition.dataVersion = envelope!.dataVersion;
    partition.data = envelope!.payload as Record<string, JsonValue>;
    return { ok: true };
  };

  /** 分区数据的运行时形状校验：契约要求 initialize/migrate 返回键值对象。 */
  const asPartitionData = (
    value: unknown,
    what: string
  ):
    | { ok: true; data: Record<string, JsonValue> }
    | { ok: false; error: string } =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, data: value as Record<string, JsonValue> }
      : { ok: false, error: what + ' must return a key-value object' };

  /**
   * 版本处理：同版本直接可用；**任何已存储数据**（含旧布局导入的版本 0）都必须经
   * migrate 升级——只有完全不存在历史记录才算首次安装，避免把真实 payload 当空数据
   * 覆盖；新版本（降级）拒绝并给出诊断。
   */
  const applyVersion = (
    partition: Partition,
    hasHistory: boolean
  ): { ok: true } | { ok: false; error: string } => {
    const { version, initialize, migrate } = partition.options;
    if (!hasHistory) {
      const created = asPartitionData(initialize(), 'initialize()');
      if (created.ok === false) return created;
      partition.data = created.data;
      partition.dataVersion = version;
      partition.forceCommit = true;
      markDirty(partition);
      return { ok: true };
    }
    if (partition.dataVersion === version) return { ok: true };
    if (partition.dataVersion > version)
      return {
        ok: false,
        error:
          'stored dataVersion ' +
          partition.dataVersion +
          ' is newer than plugin version ' +
          version,
      };
    if (!migrate)
      return {
        ok: false,
        error:
          'missing migrate for stored dataVersion ' + partition.dataVersion,
      };
    const fromVersion = partition.dataVersion;
    const migrated = asPartitionData(
      migrate(partition.data, partition.dataVersion),
      'migrate()'
    );
    if (migrated.ok === false) return migrated;
    partition.data = migrated.data;
    partition.dataVersion = version;
    partition.forceCommit = true;
    markDirty(partition);
    log.info(
      'partition ' +
        key(partition.pluginId, partition.localId) +
        ' migrated dataVersion ' +
        fromVersion +
        ' -> ' +
        version
    );
    return { ok: true };
  };

  const markDirty = (partition: Partition): void => {
    if (!partition.dirty) partition.dirtySince = currentTick;
    partition.dirty = true;
  };

  /** 申请配置校验：非法配置是装配错误，立即抛出，不进入 pending。 */
  const resolveOptions = <M extends object>(
    localId: string,
    options: MemoryApplicationOptions<M>
  ): AppliedOptions => {
    if (!isStableKey(localId)) throw configError('invalid localId: ' + localId);
    if (!Number.isInteger(options.version) || options.version < 1)
      throw configError('version must be a positive integer');
    if (options.layer !== 'critical' && options.layer !== 'checkpoint')
      throw configError('invalid persistence layer');
    const interval = options.checkpointInterval ?? 100;
    if (!Number.isInteger(interval) || interval < 1)
      throw configError('checkpointInterval must be a positive integer');
    if (
      options.layer !== 'checkpoint' &&
      options.checkpointInterval !== undefined
    )
      throw configError(
        'checkpointInterval is only valid for checkpoint layer'
      );
    if (options.priority !== undefined && !Number.isFinite(options.priority))
      throw configError('priority must be a finite number');
    if (typeof options.initialize !== 'function')
      throw configError('initialize must be a function');
    return {
      version: options.version,
      layer: options.layer,
      checkpointInterval: interval,
      priority: options.priority,
      initialize: options.initialize as () => object,
      migrate: options.migrate as
        ((memory: unknown, fromVersion: number) => object) | undefined,
    };
  };

  /** 重复申请只有"声明完全一致"才复用；函数按引用比较，不做源码级等价判断。 */
  const sameDeclaration = (
    partition: Partition,
    next: AppliedOptions
  ): boolean =>
    partition.options.version === next.version &&
    partition.options.layer === next.layer &&
    partition.options.checkpointInterval === next.checkpointInterval &&
    partition.options.priority === next.priority &&
    partition.options.initialize === next.initialize &&
    partition.options.migrate === next.migrate;

  /**
   * 创建访问句柄。
   *
   * ready 句柄绑定签发 tick 与当时的数据引用：跨 tick 调用、分区进入 pending、或数据
   * 被重新加载都会抛协议错误。契约规定 ready 引用只对当 tick 有效，这里用运行时检查
   * 把该约定落实，避免旧句柄绕过迁移冻结或写回已经脱离事实源的对象。
   */
  const createAccessor = (partition: Partition): MemoryAccessor<any> => ({
    access: (): MemoryAccess<any> => {
      if (partition.pending)
        return {
          status: 'pending',
          reason: partition.pending.reason,
          retryAt: partition.pending.retryAt,
        };
      const issuedData = partition.data;
      if (issuedData === null)
        return {
          status: 'pending',
          reason: 'loading',
          retryAt: currentTick + 1,
        };
      const issuedTick = currentTick;
      const assertUsable = (): void => {
        if (currentTick !== issuedTick)
          throw configError(
            'ready handle issued at tick ' +
              issuedTick +
              ' cannot be used at tick ' +
              currentTick
          );
        if (partition.pending)
          throw configError(
            'partition is pending (' + partition.pending.reason + ')'
          );
        if (partition.data !== issuedData)
          throw configError('partition data was reloaded; access again');
      };
      return {
        status: 'ready',
        query: () => {
          assertUsable();
          return issuedData as DeepReadonly<any>;
        },
        commit: <R>(mutator: (memory: any) => R): R => {
          assertUsable();
          markDirty(partition);
          return mutator(issuedData);
        },
      };
    },
  });

  /** 新建分区：目录立即落一条记录，数据先写 Raw（窗口封存后再决定是否搬到 Segment）。 */
  const createPartition = (
    pluginId: string,
    localId: string,
    applied: AppliedOptions
  ): Partition => {
    const partition: Partition = {
      pluginId,
      localId,
      options: applied,
      generation: 0,
      backend: 'raw',
      data: null,
      dataVersion: applied.version,
      dirty: false,
      forceCommit: false,
      pending: null,
      writeError: null,
      lastLoggedError: null,
      accessor: null,
    };
    const version = applyVersion(partition, false);
    if (version.ok === false) throw configError(version.error);
    writeAllocation(pluginId, localId, { backend: 'raw', generation: 0 });
    writeRawPartition(
      pluginId,
      localId,
      partition.dataVersion,
      partition.data!
    );
    partition.accessor = createAccessor(partition);
    return partition;
  };

  /** 恢复已有分区：目录决定后端，后端决定数据来源，随后处理版本与 pending。 */
  const restoreExistingPartition = (
    pluginId: string,
    localId: string,
    allocation: AllocationRecord,
    applied: AppliedOptions
  ): Partition => {
    const partition: Partition = {
      pluginId,
      localId,
      options: applied,
      generation: allocation.generation,
      backend: allocation.backend,
      segmentId: allocation.segmentId,
      data: null,
      dataVersion: 0,
      dirty: false,
      forceCommit: false,
      pending: null,
      writeError: null,
      lastLoggedError: null,
      accessor: null,
    };
    const restored = restorePartition(partition);
    if (restored.ok === false) {
      setPending(partition, restored.reason);
      partition.writeError = restored.error ?? null;
      if (restored.error)
        log.error(
          'partition ' + key(pluginId, localId) + ': ' + restored.error
        );
      partition.accessor = createAccessor(partition);
      return partition;
    }
    const versioned = applyVersion(partition, true);
    if (versioned.ok === false) {
      setPending(partition, 'recovery');
      partition.writeError = versioned.error;
      partition.accessor = createAccessor(partition);
      return partition;
    }
    partition.accessor = createAccessor(partition);
    return partition;
  };

  /** 带 owner 的内部申请实现；对外通过 bind(owner) 收敛为 ApplyMemoryAccessor。 */
  type ApplyWithOwner = <M extends object>(
    owner: string,
    localId: string,
    options: MemoryApplicationOptions<M>
  ) => MemoryAccessor<M>;

  const apply: ApplyWithOwner = <M extends object>(
    owner: string,
    localId: string,
    options: MemoryApplicationOptions<M>
  ): MemoryAccessor<M> => {
    if (!isStableKey(owner)) throw configError('invalid owner: ' + owner);
    const applied = resolveOptions(localId, options);
    const identity = key(owner, localId);
    const existing = partitions.get(identity);
    if (existing) {
      if (!sameDeclaration(existing, applied))
        throw configError('conflicting declaration for ' + identity);
      return existing.accessor as MemoryAccessor<M>;
    }
    if (!loaded && fault === null)
      throw configError('begin(tick) must run before applying for memory');
    if (fault !== null) {
      // 存储不可解析时不能假装是新分区，也不能抛错中断模块的无关行为：
      // 返回持久 pending 并把故障暴露在 getStatus().fault。
      const pending: Partition = {
        pluginId: owner,
        localId,
        options: applied,
        generation: 0,
        backend: 'raw',
        data: null,
        dataVersion: applied.version,
        dirty: false,
        forceCommit: false,
        pending: { reason: 'recovery', retryAt: currentTick },
        writeError: fault,
        lastLoggedError: fault,
        accessor: null,
      };
      pending.accessor = createAccessor(pending);
      partitions.set(identity, pending);
      return pending.accessor as MemoryAccessor<M>;
    }
    const allocation = allocationOf(owner, localId);
    const partition = allocation
      ? restoreExistingPartition(owner, localId, allocation, applied)
      : createPartition(owner, localId, applied);
    partitions.set(identity, partition);
    return partition.accessor as MemoryAccessor<M>;
  };

  /**
   * 规划本 global 的页分配。
   *
   * 只有在所有固定页都被观察过之后才执行：没读过的页可能是别人正在使用的数据。
   * 已占用的页包括目录中所有 segment 分配（含本 global 未申请的模块）与 journal
   * 涉及的页；落选者（含被抢占的原所有者）先腾退，入选者再取一个"已观察且为空"的
   * 空闲页。没有可用页时该分区继续留在主 Memory，不报错。
   */
  const planAllocation = (): void => {
    allocationPlanned = true;
    const journal = store!.namespace.migration;
    const inFlight = new Set(
      (journal?.moves ?? []).map((move) => key(move.pluginId, move.localId))
    );
    allocationSkipped = [];
    const candidates = [...partitions.values()]
      .filter((partition) => {
        if (partition.options.priority === undefined) return false;
        if (inFlight.has(key(partition.pluginId, partition.localId)))
          return false;
        // 数据未装载或已损坏的分区不参与搬迁：否则会把未知版本搬进新页，
        // 甚至覆盖仍在存储里的真实数据。诊断里区分"损坏"与"尚未装载"。
        if (partition.pending?.reason === 'recovery') {
          allocationSkipped.push({
            pluginId: partition.pluginId,
            localId: partition.localId,
            reason: 'recovery',
          });
          return false;
        }
        if (partition.data === null) {
          allocationSkipped.push({
            pluginId: partition.pluginId,
            localId: partition.localId,
            reason: 'data-not-loaded',
          });
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const byPriority =
          (b.options.priority ?? 0) - (a.options.priority ?? 0);
        if (byPriority !== 0) return byPriority;
        return key(a.pluginId, a.localId) < key(b.pluginId, b.localId) ? -1 : 1;
      });
    const eligible = new Set(
      candidates
        .slice(0, segmentIds.length)
        .map((partition) => key(partition.pluginId, partition.localId))
    );
    // 先统计即将被腾退的页：它们会在本批串行队列里先清空，随后可分配给入选者。
    const vacatingPages = new Map<number, string>();
    for (const partition of candidates) {
      const identity = key(partition.pluginId, partition.localId);
      if (eligible.has(identity)) continue;
      if (partition.backend !== 'segment' || partition.segmentId === undefined)
        continue;
      vacatingPages.set(partition.segmentId, identity);
    }
    const claimed = new Set<number>();
    for (const bucket of Object.values(store!.namespace.allocations))
      for (const record of Object.values(bucket)) {
        if (record.backend !== 'segment' || record.segmentId === undefined)
          continue;
        // 即将腾退的页不占用名额：本批串行队列会先清空它，再分配给入选者；
        // 目录中其他模块（本 global 未申请）的页照常占用，不允许被抢占。
        if (vacatingPages.has(record.segmentId)) continue;
        claimed.add(record.segmentId);
      }
    for (const move of journal?.moves ?? []) {
      if (move.fromSegmentId !== undefined) claimed.add(move.fromSegmentId);
      if (move.toSegmentId !== undefined) claimed.add(move.toSegmentId);
    }
    // 腾退：落选的原页所有者搬回 Raw，释放页。
    for (const partition of candidates) {
      const identity = key(partition.pluginId, partition.localId);
      if (eligible.has(identity)) continue;
      if (partition.backend !== 'segment') continue;
      moveQueue.push({
        pluginId: partition.pluginId,
        localId: partition.localId,
        dataVersion: partition.dataVersion,
        from: 'segment',
        fromSegmentId: partition.segmentId,
        to: 'raw',
      });
    }
    // 迁入：入选但还没有页的分区按 ID 顺序取空闲页（腾退中的页也可预约）。
    for (const partition of candidates) {
      const identity = key(partition.pluginId, partition.localId);
      if (!eligible.has(identity)) continue;
      if (partition.backend === 'segment') continue;
      const free = segmentIds.find(
        (id) => !claimed.has(id) && (pageAvailable(id) || vacatingPages.has(id))
      );
      if (free === undefined) continue;
      claimed.add(free);
      moveQueue.push({
        pluginId: partition.pluginId,
        localId: partition.localId,
        dataVersion: partition.dataVersion,
        from: 'raw',
        to: 'segment',
        toSegmentId: free,
      });
    }
  };

  /**
   * 清空被腾退的页。
   *
   * 目录切换后旧页不再被引用，清空只是回收容量：页不可见时留待下次观察（届时会被识别
   * 为保留页而不是被覆盖），写入抛错只记录诊断，绝不阻止目录切换——数据此时已经在
   * 主 Memory 里留有副本。
   */
  const clearVacatedSegment = (id: number, report = true): boolean => {
    if (segmentsVisible()[id] === undefined) {
      observedSegments.delete(id);
      if (report)
        log.warn('segment ' + id + ' not visible for cleanup; will retry');
      return false;
    }
    try {
      platform.writeSegment(id, '');
      observedSegments.set(id, '');
      reservedSegments.delete(id);
      return true;
    } catch (error) {
      observedSegments.delete(id);
      if (report)
        log.warn(
          'segment ' +
            id +
            ' cleanup failed: ' +
            (error instanceof Error ? error.message : String(error))
        );
      return false;
    }
  };

  /** 搬迁冻结：参与搬迁的分区在 copy/verify 阶段进入 pending，避免中途数据继续变化。 */
  const freezeMoves = (
    moves: readonly MigrationMove[],
    reason: MemoryPendingReason = 'migration'
  ): void => {
    for (const move of moves) {
      const partition = partitions.get(key(move.pluginId, move.localId));
      if (!partition) continue;
      setPending(partition, reason);
    }
  };

  /**
   * 中止当前迁移：清理写出的目标页（仅在目录仍不指向它时）、给在场分区留下诊断、
   * 丢弃 journal，然后继续队列中的下一个搬迁。
   */
  const abortMigration = (
    reason: string,
    moves: readonly MigrationMove[]
  ): void => {
    for (const move of moves) {
      if (move.to === 'segment' && move.toSegmentId !== undefined) {
        const allocation = allocationOf(move.pluginId, move.localId);
        const stillOurs =
          allocation?.backend === 'segment' &&
          allocation.segmentId === move.toSegmentId;
        if (!stillOurs) clearVacatedSegment(move.toSegmentId);
      }
      const partition = partitions.get(key(move.pluginId, move.localId));
      if (partition) {
        partition.writeError = reason;
        clearPending(partition);
      }
    }
    const generation = store!.namespace.migration?.generation;
    store!.namespace.migration = null;
    migrationPersisted = false;
    store!.markMigrationDirty();
    rawDirty = true;
    log.warn('migration ' + String(generation) + ' aborted: ' + reason);
    startNextMove();
  };

  /**
   * 取出下一个仍然适用的搬迁并开启 journal。
   *
   * generation 取自持久计数器：每次搬迁都是全新代际，旧页残留的相同 owner/版本信封
   * 不会被回读校验误认成本次写入结果。
   */
  const startNextMove = (): boolean => {
    let move = moveQueue.shift();
    while (move) {
      const partition = partitions.get(key(move.pluginId, move.localId));
      // 只有"在场且已经在目标后端"才说明这条计划过期；模块不在场时照常搬迁，
      // 数据来自存储，恢复不依赖模块重新申请。
      if (!partition || partition.backend !== move.to) break;
      move = moveQueue.shift();
    }
    if (!move) return false;
    const generation = store!.namespace.generationCounter + 1;
    store!.namespace.generationCounter = generation;
    store!.namespace.migration = {
      generation,
      phase: 'copy',
      reason: move.from === 'segment' ? 'preemption' : 'allocation',
      moves: [move],
      staged: {},
    };
    store!.markMigrationDirty();
    rawDirty = true;
    migrationPersisted = false;
    freezeMoves([move]);
    log.info(
      'migration ' +
        generation +
        ' start: ' +
        key(move.pluginId, move.localId) +
        ' ' +
        move.from +
        ' -> ' +
        move.to +
        (move.toSegmentId !== undefined
          ? ' (segment ' + move.toSegmentId + ')'
          : '')
    );
    return true;
  };

  /**
   * 推进迁移一步。
   *
   * copy：把源数据（优先已冻结的内存副本，其次从 Raw 记录或 Segment 信封读取）暂存到
   * journal，并写入目标页信封；verify：下一 tick 回读目标页，用 journal 里的
   * owner/generation/dataVersion 校验；switch：更新目录、写 Raw 分区、释放被腾退的页。
   * 全程不需要模块重新申请——模块不在场时数据仍从存储搬运，恢复信息不依赖 heap。
   */
  const advanceMigration = (): void => {
    const journal = store!.namespace.migration;
    if (!journal) {
      startNextMove();
      return;
    }
    const visible = segmentsVisible();
    if (journal.phase === 'cleanup') {
      // 目录必须已经随主 Memory 成功落盘，才允许清空旧页；写入失败时停在 cleanup，
      // 由 end 重试写入（rawDirty 仍为真），成功后的下一 tick 再清理。
      if (!migrationPersisted) return;
      const attempts = (cleanupAttempts.get(journal.generation) ?? 0) + 1;
      cleanupAttempts.set(journal.generation, attempts);
      // 同一代际的清理失败只在首次尝试时告警：重试日志不重复刷屏（同一原因只记一次）。
      const report = attempts === 1;
      let allCleared = true;
      for (const item of journal.moves)
        if (
          item.fromSegmentId !== undefined &&
          !clearVacatedSegment(item.fromSegmentId, report)
        )
          allCleared = false;
      if (!allCleared && attempts < 3) {
        store!.markMigrationDirty();
        rawDirty = true;
        return;
      }
      if (!allCleared)
        log.warn(
          'migration ' +
            journal.generation +
            ' cleanup gave up on some vacated pages; they stay reserved'
        );
      cleanupAttempts.delete(journal.generation);
      store!.namespace.migration = null;
      store!.markMigrationDirty();
      rawDirty = true;
      log.info('migration ' + journal.generation + ' cleaned up');
      startNextMove();
      return;
    }
    if (journal.phase === 'copy') {
      for (const item of journal.moves) {
        const identity = key(item.pluginId, item.localId);
        const resident = partitions.get(identity);
        let payload: JsonValue;
        if (resident?.data) {
          payload = resident.data as JsonValue;
        } else if (item.from === 'segment') {
          const text = visible[item.fromSegmentId!];
          if (text === undefined) {
            ensureSegmentsActive();
            freezeMoves(journal.moves);
            return;
          }
          const envelope = parseEnvelope(text);
          if (
            !envelope ||
            envelope.owner.pluginId !== item.pluginId ||
            envelope.owner.localId !== item.localId
          ) {
            abortMigration(
              'migration source missing for ' + identity,
              journal.moves
            );
            return;
          }
          payload = envelope.payload;
        } else {
          const record = rawRecordOf(item.pluginId, item.localId);
          if (!record) {
            abortMigration(
              'migration source missing for ' + identity,
              journal.moves
            );
            return;
          }
          payload = record.payload;
        }
        journal.staged[identity] = payload;
      }
      const unmanaged = journal.moves.find(
        (item) =>
          (item.to === 'segment' && !segmentIds.includes(item.toSegmentId!)) ||
          (item.from === 'segment' && !segmentIds.includes(item.fromSegmentId!))
      );
      if (unmanaged) {
        abortMigration('migration references unmanaged segment', journal.moves);
        return;
      }
      const needVisible = journal.moves.filter((item) => item.to === 'segment');
      if (
        needVisible.some((item) => visible[item.toSegmentId!] === undefined)
      ) {
        ensureSegmentsActive();
        freezeMoves(journal.moves);
        return;
      }
      for (const item of needVisible) {
        // 目标页必须是空的（观察过的空页或刚腾退的页）；非空且不属于我们的页绝不写入。
        const target = item.toSegmentId!;
        const current = visible[target] ?? '';
        const allocation = allocationOf(item.pluginId, item.localId);
        const ours =
          allocation?.backend === 'segment' && allocation.segmentId === target;
        if (!ours && current !== '') {
          abortMigration(
            'target segment ' + target + ' is not empty',
            journal.moves
          );
          return;
        }
        try {
          platform.writeSegment(
            item.toSegmentId!,
            encodeEnvelope(
              createEnvelope(
                { pluginId: item.pluginId, localId: item.localId },
                journal.generation,
                item.dataVersion,
                journal.staged[key(item.pluginId, item.localId)]
              )
            )
          );
        } catch (error) {
          abortMigration(
            error instanceof Error ? error.message : String(error),
            journal.moves
          );
          return;
        }
      }
      journal.phase = 'verify';
      store!.markMigrationDirty();
      rawDirty = true;
      freezeMoves(journal.moves, 'verification');
      log.info(
        'migration ' + journal.generation + ' copied; awaiting verification'
      );
      return;
    }
    if (journal.phase === 'verify') {
      for (const item of journal.moves) {
        if (item.to !== 'segment') continue;
        const text = visible[item.toSegmentId!];
        if (text === undefined) {
          ensureSegmentsActive();
          const resident = partitions.get(key(item.pluginId, item.localId));
          if (resident) setPending(resident, 'segment-activating');
          return;
        }
        const mismatch = describeMismatch(
          parseEnvelope(text),
          { pluginId: item.pluginId, localId: item.localId },
          journal.generation,
          item.dataVersion
        );
        if (mismatch) {
          abortMigration(
            'migration verification failed: ' + mismatch,
            journal.moves
          );
          return;
        }
      }
      journal.phase = 'switch';
      store!.markMigrationDirty();
      rawDirty = true;
      freezeMoves(journal.moves);
      log.info(
        'migration ' + journal.generation + ' verified; switching directory'
      );
      return;
    }
    for (const item of journal.moves) {
      const identity = key(item.pluginId, item.localId);
      const resident = partitions.get(identity);
      const staged = journal.staged[identity];
      if (item.to === 'segment') {
        deleteRawPartition(item.pluginId, item.localId);
        writeAllocation(item.pluginId, item.localId, {
          backend: 'segment',
          segmentId: item.toSegmentId,
          generation: journal.generation,
        });
        if (resident) {
          resident.backend = 'segment';
          resident.segmentId = item.toSegmentId;
          resident.generation = journal.generation;
          resident.dirty = false;
          resident.dirtySince = undefined;
          resident.forceCommit = false;
          // 数据尚未装载时显式回到 loading，让下一 tick 从新后端装载；
          // 否则会出现"无 pending 也无数据"的失真状态（accessor 永久 loading）。
          if (resident.data === null) setPending(resident, 'loading');
          else clearPending(resident);
        }
      } else {
        writeRawPartition(
          item.pluginId,
          item.localId,
          item.dataVersion,
          (resident?.data ?? staged) as JsonValue
        );
        writeAllocation(item.pluginId, item.localId, {
          backend: 'raw',
          generation: journal.generation,
        });
        if (resident) {
          resident.backend = 'raw';
          resident.segmentId = undefined;
          resident.generation = journal.generation;
          resident.dirty = false;
          resident.dirtySince = undefined;
          resident.forceCommit = false;
          if (resident.data === null) setPending(resident, 'loading');
          else clearPending(resident);
        }
        // 被腾退的页留到 cleanup 阶段（目录成功落盘后）再清空。
      }
      delete journal.staged[identity];
    }
    // 目录切换只改 heap；被腾退的页要等包含新目录的整串写入成功之后，在 cleanup
    // 阶段才清空——否则主 Memory 写失败叠加 global reset 会留下"存储目录仍指向
    // 已清空页"的悬空引用，旧数据的唯一副本随之丢失。
    journal.phase = 'cleanup';
    store!.markMigrationDirty();
    rawDirty = true;
    migrationPersisted = false;
    log.info('migration ' + journal.generation + ' switched; cleanup pending');
    return;
  };

  /** 分区是否到期提交：critical 与强制提交当 tick，checkpoint 按首次 dirty 起算。 */
  const isDue = (partition: Partition, tick: number): boolean =>
    partition.forceCommit ||
    partition.options.layer === 'critical' ||
    (partition.dirtySince !== undefined &&
      tick - partition.dirtySince >= partition.options.checkpointInterval - 1);

  /**
   * 暂存到期分区并写 Segment 信封。
   *
   * Raw 分区只更新命名空间对象，返回值交给 end 在整串写入成功后统一清 dirty——
   * 若在这里就清，主 Memory 写入失败时会把"未落盘"误判成"已提交"。
   */
  const commitPartitions = (tick: number): Partition[] => {
    const stagedRaw: Partition[] = [];
    for (const partition of partitions.values()) {
      if (!partition.dirty || !isDue(partition, tick)) continue;
      // pending 期间数据不在稳定状态（页未激活、搬迁冻结、损坏）：本 tick 不写回。
      if (partition.pending) continue;
      if (partition.backend === 'raw') {
        writeRawPartition(
          partition.pluginId,
          partition.localId,
          partition.dataVersion,
          partition.data as JsonValue
        );
        stagedRaw.push(partition);
        continue;
      }
      // 页未激活时写入没有意义：请求激活并保持 dirty，下一 tick 再提交。
      if (
        partition.segmentId === undefined ||
        segmentsVisible()[partition.segmentId] === undefined
      ) {
        ensureSegmentsActive();
        setPending(partition, 'segment-activating');
        continue;
      }
      try {
        const envelope = createEnvelope(
          { pluginId: partition.pluginId, localId: partition.localId },
          partition.generation,
          partition.dataVersion,
          partition.data as JsonValue
        );
        platform.writeSegment(partition.segmentId, encodeEnvelope(envelope));
        partition.dirty = false;
        partition.dirtySince = undefined;
        partition.forceCommit = false;
        partition.writeError = null;
        partition.lastLoggedError = null;
      } catch (error) {
        // 单页失败不影响其他分区；保留 dirty 与诊断，下一 tick 重试。
        const message = error instanceof Error ? error.message : String(error);
        partition.writeError = message;
        if (partition.lastLoggedError !== message) {
          partition.lastLoggedError = message;
          log.warn(
            'segment write failed for ' +
              key(partition.pluginId, partition.localId) +
              ': ' +
              message
          );
        }
      }
    }
    return stagedRaw;
  };

  const begin = (tick: number): void => {
    currentTick = tick;
    deferredThisTick = false;
    if (!loaded && fault === null) {
      try {
        const loadedRoot = loadRawRoot(platform.readRaw());
        store = createRawStore(loadedRoot);
        // 加载到的 journal 已经存在于存储中，可以直接进入后续阶段。
        migrationPersisted = store.namespace.migration !== null;
        // 加载期被安全跳过的内容（例如旧布局的原型键）：只记录诊断，不阻断启动。
        for (const warning of loadedRoot.warnings) log.warn(warning);
        loaded = true;
      } catch (error) {
        fault = error instanceof Error ? error.message : String(error);
        // fault 只建立一次，因此这条 error 每个实例最多出现一次。
        log.error('storage load failed: ' + fault);
      }
    }
    if (!loaded) return;
    ensureSegmentsActive();
    refreshObservations();
    /**
     * 重试等待中的分区。
     *
     * 两种情形需要重试：①上一 tick 申请激活的页本 tick 可见；②分区没有数据
     * （switch 之后或装载失败）。规则：
     * - 冻结类 pending（migration/verification）必须保持——搬迁期间若恢复 ready，
     *   插件的新提交不会被搬进目标，却会在 switch 时被清 dirty，造成静默丢失；
     *   冻结时刻的数据由搬迁本身落盘。
     * - 有未提交修改（dirty）时 heap 是事实源，只清 pending 让下一次提交重试，
     *   绝不能用存储里的旧信封覆盖脏数据。
     * - recovery 且无数据时允许重读自愈（结论保留在 writeError 中，语义是
     *   "最近一次故障"，不代表当前仍不可用）。
     */
    for (const partition of partitions.values()) {
      const pendingReason = partition.pending?.reason;
      if (pendingReason === 'migration' || pendingReason === 'verification')
        continue;
      if (partition.dirty) {
        clearPending(partition);
        continue;
      }
      if (partition.data !== null) continue;
      const restored = restorePartition(partition);
      if (restored.ok === false) {
        if (restored.reason === 'recovery') {
          setPending(partition, 'recovery');
          partition.writeError = restored.error ?? null;
        }
        continue;
      }
      const versioned = applyVersion(partition, true);
      if (versioned.ok === false) {
        setPending(partition, 'recovery');
        partition.writeError = versioned.error;
        log.error(
          'partition ' +
            key(partition.pluginId, partition.localId) +
            ': ' +
            versioned.error
        );
        continue;
      }
      clearPending(partition);
      log.info(
        'partition ' + key(partition.pluginId, partition.localId) + ' recovered'
      );
    }
  };

  const end = (tick: number): void => {
    if (!loaded || fault !== null) return;
    refreshObservations();
    // 1) 启动窗口：申请收齐才封存；被延后到上限后强制封存并记录诊断。
    if (startupWindowOpen) {
      if (deferredThisTick && startupDeferrals < maxStartupDeferrals) {
        startupDeferrals++;
      } else {
        startupWindowOpen = false;
        startupWindowForced = deferredThisTick;
        if (startupWindowForced)
          log.warn(
            'startup window force-sealed after ' +
              startupDeferrals +
              ' deferrals; late applications stay on raw memory'
          );
      }
    } else if (!allocationPlanned) {
      // 2) 页分配等所有固定页都被观察过：没读过的页不能假定为空。
      if (unobservedSegments().length === 0) {
        planAllocation();
      } else {
        if (observationSinceTick < 0) observationSinceTick = tick;
        if (tick - observationSinceTick >= maxObservationTicks) {
          // 观察不到页（例如引擎未激活）：放弃 Segment 分配，全部留在主 Memory。
          allocationPlanned = true;
        }
      }
    }
    // 3) 推进迁移、暂存到期分区，最后一次性写出主 Memory。
    advanceMigration();
    const stagedRaw = commitPartitions(tick);
    const external = getHostMemory() ?? null;
    const externalChanged = store!.hasExternalChanges(external);
    if (!rawDirty && !externalChanged) return;
    try {
      platform.writeRaw(store!.serialize(external));
      rawDirty = false;
      migrationPersisted = store!.namespace.migration !== null;
      store!.commitExternal(external);
      for (const partition of stagedRaw) {
        partition.dirty = false;
        partition.dirtySince = undefined;
        partition.forceCommit = false;
        partition.writeError = null;
        partition.lastLoggedError = null;
      }
    } catch (error) {
      // 主 Memory 写入失败：保留 rawDirty 与分区 dirty，记录诊断并在下一 tick 重试。
      const message = error instanceof Error ? error.message : String(error);
      for (const partition of stagedRaw) {
        partition.writeError = message;
        if (partition.lastLoggedError !== message) {
          partition.lastLoggedError = message;
          log.warn(
            'raw write failed for ' +
              key(partition.pluginId, partition.localId) +
              ': ' +
              message
          );
        }
      }
    }
  };

  /** 本轮申请未收齐时延后封存窗口（例如框架进入安全模式或跳过部分插件）。 */
  const deferStartupWindow = (): void => {
    deferredThisTick = true;
  };

  const bind =
    (owner: string): ApplyMemoryAccessor =>
    (localId, applicationOptions) =>
      apply(owner, localId, applicationOptions);

  const getStatus = (): MemoryManagerStatus => ({
    loaded,
    fault,
    tick: currentTick,
    startupWindowOpen,
    startupWindowForced,
    startupDeferrals,
    allocations: [...partitions.values()].map((partition) => ({
      pluginId: partition.pluginId,
      localId: partition.localId,
      backend: partition.backend,
      segmentId: partition.segmentId,
      // pending 以 accessor 的实际判定为准：无数据即 loading，避免状态与真实相反。
      pending:
        partition.pending?.reason ??
        (partition.data === null ? 'loading' : null),
      dirty: partition.dirty,
      writeError: partition.writeError,
    })),
    migration: store?.namespace.migration
      ? {
          generation: store.namespace.migration.generation,
          phase: store.namespace.migration.phase,
          reason: store.namespace.migration.reason,
          moves: store.namespace.migration.moves.length,
        }
      : null,
    reservedSegments: [...reservedSegments].map(([segmentId, reason]) => ({
      segmentId,
      reason,
    })),
    allocationSkipped: allocationSkipped.map((entry) => ({ ...entry })),
    unobservedSegments: unobservedSegments(),
    preservedRootKeys: store ? store.preservedKeys() : [],
  });

  return { begin, end, deferStartupWindow, bind, getStatus };
};
