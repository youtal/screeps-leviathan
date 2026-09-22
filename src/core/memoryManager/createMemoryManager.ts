/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的主实现，是项目访问持久化存储的唯一入口（AGENTS.md §9）。
 *
 * 主要功能：为每个 (owner, localId) 提供独立逻辑分区与长期有效的访问器（query/get/commit/remove），
 * 由宿主 begin/end 驱动 tick 生命周期：首次 begin 同步装载主存储，end 统一提交全部脏分区。
 *
 * 实现过程：装载只解析一次主文本，记录以解析出的 payload 暂存；申请同版本分区时直接取用该对象，
 * 迁移前先把它编码为已提交片段以固定基线。修改把分区加入去重的脏集合；end 只编码脏分区，
 * clean 分区复用片段（首次拼接时才为尚未编码的记录与根字段生成），拼接成完整文本后一次写入平台。
 *
 * 技术要点：
 * - 空闲 tick 的 end 是 O(1)：脏集合为空且无结构变化时直接返回，不遍历、不序列化、不写平台。
 * - 回调修改置 needsFullValidation，收尾先完整校验再用无 replacer 的 JSON.stringify 编码；
 *   只经路径写入/删除的分区因新值已在写入时校验，直接编码。
 * - 提交顺序固定为“平台接受 → 更新全部候选基线 → 清理脏集合”，任何一步失败或中断都完整保留
 *   脏集合，下一次 end 按最新工作对象重试。
 * - 生命周期锁带 tick 归属：真实 tick 来自平台 getTick，同一执行栈中的回调无法伪造新 tick；
 *   硬终止遗留的旧 tick 锁在下一个真实 tick 的 begin 中清除。
 * - initialize/migrate 返回值与路径写入的新值都在校验的同一次遍历中复制，调用方保留原对象。
 * - 所有状态只驻留本实例 heap，global reset 后从平台文本重建；未提交的 heap 修改随之丢失。
 */
import type {
  ApplyMemoryAccessor,
  DeepReadonly,
  MemoryAccessor,
  MemoryApplicationOptions,
  MemoryHost,
} from '@/contracts/memory';
import type { LoggerFactory } from '@/contracts/logging';
import { encodeRecord, loadStore } from './namespace';
import { createScreepsPlatform } from './platform';
import { locateRemove, locateWrite, normalizePath, readPath } from './paths';
import {
  copyPublish,
  copyPublishRoot,
  validateForCommit,
  validatePublishRoot,
} from './validate';
import {
  NAMESPACE_KEY,
  NAMESPACE_SCHEMA_VERSION,
  RAW_MEMORY_LIMIT,
  type MemoryManagerStatus,
  type MemoryPlatform,
  type WriteFailure,
} from './types';

/** 调用协议或配置错误：直接抛给调用者，不伪装成等待状态。 */
const configError = (message: string): Error =>
  new Error('MemoryManager: ' + message);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 可申请的身份键：字母数字开头，只含 `._-`，并排除原型相关键。 */
const isStableKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
  value !== 'prototype' &&
  value !== 'constructor' &&
  !Object.prototype.hasOwnProperty.call(Object.prototype, value);

/** 回调返回 Promise/thenable 即违反同步契约。 */
const isThenable = (value: unknown): boolean =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function';

/** 旧协议字段：JavaScript 调用方仍可能传入，显式拒绝以免静默忽略语义。 */
const REMOVED_OPTIONS = ['layer', 'checkpointInterval', 'priority'] as const;

/** 规范化后的申请声明；函数按引用比较，决定重复申请是否同一声明。 */
interface Declaration {
  version: number;
  initialize: () => unknown;
  migrate: ((memory: unknown, fromVersion: number) => unknown) | undefined;
}

/** 已发布访问器的分区：工作对象、声明、访问器及收尾校验标记。 */
interface Applied {
  entry: Entry;
  declaration: Declaration;
  /** 工作对象；发布时已通过受管数据校验，之后只经访问器修改。 */
  data: Record<string, unknown>;
  accessor: MemoryAccessor<any>;
  /** 回调修改后置位，end 成功更新该分区基线时清除。 */
  needsFullValidation: boolean;
  /** 正在执行 commit(mutator) 回调的 tick；用于拒绝同分区重入，旧 tick 的值视为过期。 */
  mutatingTick: number;
}

/** 一条已存储或新建的分区记录；未申请时 applied 为 null，只保留片段。 */
interface Entry {
  owner: string;
  localId: string;
  /** `"localId":` 的预编码前缀，拼接时免去重复转义。 */
  keyPrefix: string;
  dataVersion: number;
  /**
   * 已提交基线片段，按需生成：装载的记录在首次拼接或迁移前才编码（此前为 null，数据暂存在
   * retained）；新建分区在首次成功提交前为 null（此时必在脏集合中）。
   */
  fragment: string | null;
  /**
   * 装载时解析出、尚未编码的历史 payload。生命周期：首次拼接时编码为 fragment 后释放；同版本
   * 申请时直接成为工作对象并释放；迁移前先编码基线再交给 migrate 并释放。未申请的历史分区在
   * 首次提交前以对象形式驻留 heap。
   */
  retained: { payload: unknown } | null;
  applied: Applied | null;
}

/** 同一 owner 的分区桶；Map 保持装载/创建顺序，输出顺序因此稳定。 */
interface OwnerBucket {
  /** `"owner":{` 的预编码前缀。 */
  prefix: string;
  entries: Map<string, Entry>;
}

export interface MemoryManagerOptions {
  /**
   * Runtime 先创建的日志工厂。该依赖必须显式提供，MemoryManager 不导入同级实现，
   * 从而保证 Core 模块的依赖方向只由组合根决定。
   */
  logging: LoggerFactory;
  /** 平台端口；缺省直连 Screeps RawMemory，tick 取自 getTick。提供时整体生效，忽略 getTick。 */
  platform?: MemoryPlatform;
  /**
   * 缺省平台的真实 tick 来源；缺省读取全局 `Game.time`。Runtime 注入 `() => getGame().time`，
   * 使 Framework 传给 begin/end 的 tick 与这里的判定出自同一个 Game 端口。
   */
  getTick?: () => number;
}

/** 管理器对外能力：MemoryHost 生命周期 + 完整诊断快照。 */
export interface MemoryManager extends MemoryHost {
  getStatus(): MemoryManagerStatus;
}

/** `"memoryManager":{"schemaVersion":2,"partitions":{` 常量前缀，模块加载时编码一次。 */
const NAMESPACE_OPEN =
  JSON.stringify(NAMESPACE_KEY) +
  ':{"schemaVersion":' +
  NAMESPACE_SCHEMA_VERSION +
  ',"partitions":{';

export const createMemoryManager = (
  options: MemoryManagerOptions
): MemoryManager => {
  const platform = options.platform ?? createScreepsPlatform(options.getTick);
  const log = options.logging.scope('MemoryManager');

  // ---- 装载结果（首次 begin 成功后发布，之后只读） ----
  let loaded = false;
  let loadError: string | null = null;
  /** 非托管根字段拼成的前缀；首次拼接时由 foreignValues 生成，之后固定。 */
  let foreignPrefix: string | null = null;
  let foreignValues: [string, unknown][] = [];
  let preservedKeys: string[] = [];
  let ignoredSegmentPartitions: { owner: string; localId: string }[] = [];
  const buckets = new Map<string, OwnerBucket>();

  // ---- 待提交状态（跨 tick 保留，直到提交成功） ----
  /** 脏分区集合：待提交工作的唯一索引。 */
  const dirty = new Set<Applied>();
  /** 格式转换产生的结构变化，需要在没有业务修改时也写出。 */
  let structureChanged = false;
  let writeFailure: WriteFailure | null = null;
  let lastLoggedWriteError: string | null = null;

  // ---- 生命周期（均带 tick 归属） ----
  /** 最近一次 begin 的 tick；-1 表示尚未 begin。 */
  let phaseTick = -1;
  /** 本 phaseTick 的写入阶段是否开放；end 关闭后同 tick 不再重开。 */
  let phaseOpen = false;
  /** 正在执行用户回调或提交时的嵌套计数与所属 tick；旧 tick 的计数视为硬终止遗留。 */
  let busyDepth = 0;
  let busyTick = -1;
  /** 本 tick 正在申请中的身份，拒绝 initialize/migrate 内对同一身份的重入申请。 */
  const applying = new Set<string>();
  /** 失败申请缓存：相同声明不重跑失败的回调，直接重抛同一错误。 */
  const failedApplications = new Map<string, { declaration: Declaration; error: Error }>();

  const identity = (owner: string, localId: string): string => owner + '/' + localId;

  const enterBusy = (): void => {
    if (busyTick !== phaseTick) busyDepth = 0;
    busyTick = phaseTick;
    busyDepth++;
  };
  const exitBusy = (): void => {
    busyDepth--;
  };
  /** 当前真实 tick 内是否有回调或提交正在执行（同步重入的判据）。 */
  const isBusy = (now: number): boolean => busyDepth > 0 && busyTick === now;

  /** 修改前置条件：写入阶段开放，且本分区没有正在执行的回调。 */
  const assertWritable = (applied: Applied): void => {
    if (!phaseOpen)
      throw configError(
        'modifications are only allowed between begin and end (tick ' + phaseTick + ')'
      );
    if (applied.mutatingTick === phaseTick)
      throw configError(
        'partition ' +
          identity(applied.entry.owner, applied.entry.localId) +
          ' is being modified by a commit callback'
      );
  };

  const markDirty = (applied: Applied, fullValidation: boolean): void => {
    if (fullValidation) applied.needsFullValidation = true;
    dirty.add(applied);
  };

  // ---------------------------------------------------------------------------
  // 访问器
  // ---------------------------------------------------------------------------

  /**
   * 为分区创建稳定访问器。方法只捕获 applied 记录（global 内不替换），每次调用都读取
   * 其当前 data，因此不存在按 tick 失效的视图。
   */
  const createAccessor = (applied: Applied): MemoryAccessor<any> => {
    const get = (keyOrPath: unknown): unknown =>
      readPath(applied.data, normalizePath(keyOrPath));

    // 剩余参数区分“路径写入缺少 value”与“显式传入的值”；箭头函数没有自己的 arguments。
    const commit = (...args: unknown[]): unknown => {
      const first = args[0];
      if (typeof first === 'function') {
        assertWritable(applied);
        // 回调前标脏并要求完整校验：回调可能任意原地修改，抛错或中断也不能丢失这一事实。
        markDirty(applied, true);
        applied.mutatingTick = phaseTick;
        enterBusy();
        let result: unknown;
        try {
          result = (first as (memory: unknown) => unknown)(applied.data);
        } finally {
          exitBusy();
          applied.mutatingTick = -1;
        }
        if (isThenable(result))
          throw configError('commit callback must be synchronous');
        return result;
      }
      if (args.length < 2)
        throw configError('commit requires a value for path writes');
      const value = args[1];
      assertWritable(applied);
      const path = normalizePath(first);
      const target = locateWrite(applied.data, path);
      if (value === undefined)
        throw configError('undefined is not a JSON value; use remove to delete');
      // 预检：新值受管校验并复制（调用方保留原对象，之后修改、冻结或复用它都不影响分区），
      // 且不得引用写入目标的任何祖先。
      const copied = copyPublish(
        value,
        value !== null && typeof value === 'object' ? new Set(target.ancestors) : null
      );
      markDirty(applied, false);
      (target.parent as Record<string | number, unknown>)[target.key] = copied;
      return undefined;
    };

    const remove = (keyOrPath: unknown): boolean => {
      assertWritable(applied);
      const located = locateRemove(applied.data, normalizePath(keyOrPath));
      if (located === null) return false;
      markDirty(applied, false);
      delete located.parent[located.key];
      return true;
    };

    return {
      query: () => applied.data as DeepReadonly<any>,
      get: get as MemoryAccessor<any>['get'],
      commit: commit as MemoryAccessor<any>['commit'],
      remove: remove as MemoryAccessor<any>['remove'],
    };
  };

  // ---------------------------------------------------------------------------
  // 申请
  // ---------------------------------------------------------------------------

  const resolveDeclaration = (options: MemoryApplicationOptions<object>): Declaration => {
    if (options === null || typeof options !== 'object')
      throw configError('application options must be an object');
    for (const key of REMOVED_OPTIONS)
      if (key in options)
        throw configError('option ' + key + ' is no longer supported');
    if (!Number.isSafeInteger(options.version) || options.version < 1)
      throw configError('version must be a positive integer');
    if (typeof options.initialize !== 'function')
      throw configError('initialize must be a function');
    if (options.migrate !== undefined && typeof options.migrate !== 'function')
      throw configError('migrate must be a function');
    return {
      version: options.version,
      initialize: options.initialize,
      migrate: options.migrate,
    };
  };

  const sameDeclaration = (a: Declaration, b: Declaration): boolean =>
    a.version === b.version && a.initialize === b.initialize && a.migrate === b.migrate;

  /** 同步运行用户回调；thenable 结果违反契约。 */
  const runCallback = <T>(callback: () => T, what: string): T => {
    const value = callback();
    if (isThenable(value)) throw new Error(what + ' must be synchronous');
    return value;
  };

  /**
   * 编码并固定一条记录的已提交基线（幂等）。数据来源依次为：已发布分区的工作对象（clean 分区
   * 未经访问器修改，内容即持久化内容）、装载暂存的 payload。编码后释放暂存对象。
   */
  const materialize = (entry: Entry): string => {
    if (entry.fragment !== null) return entry.fragment;
    const source = entry.applied !== null ? entry.applied.data : entry.retained!.payload;
    entry.fragment = encodeRecord(entry.dataVersion, source);
    entry.retained = null;
    return entry.fragment;
  };

  /**
   * 从历史记录或 initialize 构造工作对象。initialize/migrate 的返回值在校验的同一次遍历中复制
   * （调用方可返回模块级常量、共用或冻结对象）。历史 payload 优先使用装载暂存的对象，避免二次
   * 解析；交给 migrate 之前先编码基线，migrate 修改或抛错都不影响已提交片段与其他分区。
   * consumedRetained 为真表示暂存对象已成为工作对象，发布时释放暂存引用。
   */
  const buildWorkingData = (
    entry: Entry | undefined,
    declaration: Declaration
  ): {
    data: Record<string, unknown>;
    dataVersion: number;
    changed: boolean;
    consumedRetained: boolean;
  } => {
    if (!entry) {
      const created = runCallback(declaration.initialize, 'initialize()');
      return {
        data: copyPublishRoot(created),
        dataVersion: declaration.version,
        changed: true,
        consumedRetained: false,
      };
    }
    const storedVersion = entry.dataVersion;
    if (storedVersion === declaration.version) {
      const fromRetained = entry.retained !== null;
      const payload = fromRetained
        ? entry.retained!.payload
        : (JSON.parse(entry.fragment!) as { payload: unknown }).payload;
      try {
        validatePublishRoot(payload);
      } catch (error) {
        throw new Error(
          'stored payload (dataVersion ' + storedVersion + ') is not managed data: ' +
            errorText(error) + '; declare a new version with migrate to repair it'
        );
      }
      return {
        data: payload as Record<string, unknown>,
        dataVersion: storedVersion,
        changed: false,
        consumedRetained: fromRetained,
      };
    }
    const migrate = declaration.migrate;
    if (!migrate)
      throw new Error(
        'missing migrate for stored dataVersion ' + storedVersion +
          ' (declared version ' + declaration.version + ')'
      );
    // 先固定基线，再把一个与基线无关的对象交给 migrate：暂存对象可以直接交出（之后释放），
    // 否则从基线片段解析新副本。
    let payload: unknown;
    if (entry.retained !== null) {
      payload = entry.retained.payload;
      materialize(entry);
    } else {
      payload = (JSON.parse(materialize(entry)) as { payload: unknown }).payload;
    }
    const migrated = runCallback(() => migrate(payload, storedVersion), 'migrate()');
    const data = copyPublishRoot(migrated);
    log.info(
      'partition ' + identity(entry.owner, entry.localId) + ' migrated dataVersion ' +
        storedVersion + ' -> ' + declaration.version
    );
    return { data, dataVersion: declaration.version, changed: true, consumedRetained: false };
  };

  const apply = (
    owner: string,
    localId: string,
    options: MemoryApplicationOptions<object>
  ): MemoryAccessor<any> => {
    if (!isStableKey(owner)) throw configError('invalid owner: ' + String(owner));
    if (!isStableKey(localId)) throw configError('invalid localId: ' + String(localId));
    const declaration = resolveDeclaration(options);
    const id = identity(owner, localId);
    const bucket = buckets.get(owner);
    const entry = bucket?.entries.get(localId);
    if (entry?.applied) {
      if (!sameDeclaration(entry.applied.declaration, declaration))
        throw configError('conflicting declaration for ' + id);
      return entry.applied.accessor;
    }
    if (loadError !== null) throw configError('storage load failed: ' + loadError);
    if (!loaded || !phaseOpen)
      throw configError('apply is only allowed between a successful begin and end');
    const failed = failedApplications.get(id);
    if (failed && sameDeclaration(failed.declaration, declaration)) throw failed.error;
    if (applying.has(id)) throw configError('reentrant application for ' + id);

    applying.add(id);
    enterBusy();
    let built: ReturnType<typeof buildWorkingData>;
    try {
      built = buildWorkingData(entry, declaration);
    } catch (error) {
      const wrapped = configError('partition ' + id + ': ' + errorText(error));
      failedApplications.set(id, { declaration, error: wrapped });
      throw wrapped;
    } finally {
      exitBusy();
      applying.delete(id);
    }

    // 发布：以下步骤不调用用户代码。先登记脏状态、最后才把新记录挂进输出桶——即使在两步之间
    // 被硬终止，输出也不会出现没有片段的记录（孤立的脏项不在桶中，拼接时不会被遍历）。
    failedApplications.delete(id);
    const target: Entry = entry ?? {
      owner,
      localId,
      keyPrefix: JSON.stringify(localId) + ':',
      dataVersion: built.dataVersion,
      fragment: null,
      retained: null,
      applied: null,
    };
    target.dataVersion = built.dataVersion;
    if (built.consumedRetained) target.retained = null;
    const applied: Applied = {
      entry: target,
      declaration,
      data: built.data,
      accessor: null as unknown as MemoryAccessor<any>,
      needsFullValidation: false,
      mutatingTick: -1,
    };
    applied.accessor = createAccessor(applied);
    if (built.changed) markDirty(applied, false);
    target.applied = applied;
    if (!entry) {
      let ownerBucket = bucket;
      if (!ownerBucket) {
        ownerBucket = { prefix: JSON.stringify(owner) + ':{', entries: new Map() };
        buckets.set(owner, ownerBucket);
      }
      ownerBucket.entries.set(localId, target);
    }
    return applied.accessor;
  };

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /** 校验 tick 参数与真实 tick 一致，并拒绝同一执行栈内的重入。 */
  const checkLifecycleCall = (what: string, tick: number): void => {
    if (!Number.isSafeInteger(tick)) throw configError(what + ' requires an integer tick');
    const now = platform.getTick();
    if (tick !== now)
      throw configError(what + '(' + tick + ') does not match current tick ' + now);
    if (isBusy(now)) throw configError(what + ' cannot be called reentrantly');
  };

  const load = (): void => {
    try {
      const store = loadStore(platform.readRaw());
      foreignValues = store.foreign;
      foreignPrefix = null;
      preservedKeys = store.preservedKeys;
      ignoredSegmentPartitions = store.ignoredSegmentPartitions;
      for (const record of store.records) {
        let bucket = buckets.get(record.owner);
        if (!bucket) {
          bucket = { prefix: JSON.stringify(record.owner) + ':{', entries: new Map() };
          buckets.set(record.owner, bucket);
        }
        bucket.entries.set(record.localId, {
          owner: record.owner,
          localId: record.localId,
          keyPrefix: JSON.stringify(record.localId) + ':',
          dataVersion: record.dataVersion,
          fragment: null,
          retained: { payload: record.payload },
          applied: null,
        });
      }
      structureChanged = store.structureChanged;
      for (const warning of store.warnings) log.warn(warning);
      loaded = true;
    } catch (error) {
      buckets.clear();
      loadError = errorText(error);
      log.error('storage load failed: ' + loadError);
    }
  };

  const begin = (tick: number): void => {
    checkLifecycleCall('begin', tick);
    if (tick < phaseTick) throw configError('begin(' + tick + ') is older than ' + phaseTick);
    if (tick > phaseTick) {
      // 新的真实 tick：终结上一阶段（可能因硬终止或遗漏 end 而未关闭），清除旧 tick 临时锁。
      // 脏集合、结构变化与已发布访问器全部保留，end 会按最新工作对象重试。
      phaseTick = tick;
      phaseOpen = false;
      busyDepth = 0;
      applying.clear();
      if (!loaded && loadError === null) load();
      phaseOpen = loaded;
    }
    // 同 tick 重复 begin 不重开已关闭的阶段；装载故障每次都报告给宿主。
    if (loadError !== null) throw configError('storage load failed: ' + loadError);
  };

  /** 记录整串提交失败；同一文本只告警一次。 */
  const recordFailure = (failure: WriteFailure): void => {
    writeFailure = failure;
    const text = describeFailure(failure);
    if (text !== lastLoggedWriteError) {
      lastLoggedWriteError = text;
      log.warn('memory commit failed: ' + text);
    }
  };

  const describeFailure = (failure: WriteFailure): string =>
    failure.stage +
    (failure.owner !== undefined ? ' ' + failure.owner + '/' + failure.localId : '') +
    ': ' +
    failure.message;

  /**
   * 编码脏分区并拼接完整文本。失败时抛出带阶段的 WriteFailure，调用方不推进任何基线。
   * 候选片段只存在于返回的 Map 中，失败即丢弃。
   */
  const buildText = (
    tick: number
  ): { text: string; candidates: Map<Entry, string> } => {
    const candidates = new Map<Entry, string>();
    for (const applied of dirty) {
      const entry = applied.entry;
      const where = { owner: entry.owner, localId: entry.localId };
      if (applied.needsFullValidation) {
        try {
          validateForCommit(applied.data);
        } catch (error) {
          throw { stage: 'validate', tick, message: errorText(error), ...where } as WriteFailure;
        }
      }
      let fragment: string;
      try {
        fragment = encodeRecord(entry.dataVersion, applied.data);
      } catch (error) {
        throw { stage: 'encode', tick, message: errorText(error), ...where } as WriteFailure;
      }
      candidates.set(entry, fragment);
    }
    if (foreignPrefix === null) {
      let prefix = '';
      for (const [key, value] of foreignValues)
        prefix += JSON.stringify(key) + ':' + JSON.stringify(value) + ',';
      foreignPrefix = prefix;
      foreignValues = [];
    }
    const blocks: string[] = [];
    for (const bucket of buckets.values()) {
      const parts: string[] = [];
      for (const entry of bucket.entries.values()) {
        let fragment = candidates.get(entry);
        if (fragment === undefined) {
          // 首次拼接时为尚未编码的 clean 记录生成基线；该内容即已持久化的内容，与本轮成败无关。
          try {
            fragment = materialize(entry);
          } catch (error) {
            throw {
              stage: 'encode',
              tick,
              message: errorText(error),
              owner: entry.owner,
              localId: entry.localId,
            } as WriteFailure;
          }
        }
        parts.push(entry.keyPrefix + fragment);
      }
      blocks.push(bucket.prefix + parts.join(',') + '}');
    }
    const text = '{' + foreignPrefix + NAMESPACE_OPEN + blocks.join(',') + '}}}';
    if (text.length > RAW_MEMORY_LIMIT)
      throw {
        stage: 'capacity',
        tick,
        message: 'Memory text ' + text.length + ' UTF-16 code units exceeds ' + RAW_MEMORY_LIMIT,
      } as WriteFailure;
    return { text, candidates };
  };

  const end = (tick: number): void => {
    checkLifecycleCall('end', tick);
    if (tick !== phaseTick) throw configError('end(' + tick + ') without begin');
    if (!phaseOpen) return; // 重复 end 或装载失败：不重复提交
    phaseOpen = false;
    // 空闲路径：O(1) 判断后直接返回。
    if (dirty.size === 0 && !structureChanged) return;
    enterBusy();
    try {
      let built: { text: string; candidates: Map<Entry, string> };
      try {
        built = buildText(tick);
      } catch (failure) {
        if (failure instanceof Error)
          recordFailure({ stage: 'encode', tick, message: failure.message });
        else recordFailure(failure as WriteFailure);
        return;
      }
      try {
        platform.writeRaw(built.text);
      } catch (error) {
        recordFailure({ stage: 'platform', tick, message: errorText(error) });
        return;
      }
      // 平台已接受：先更新全部候选基线，最后才清脏；中断只会导致冗余提交。
      for (const [entry, fragment] of built.candidates) {
        entry.fragment = fragment;
        if (entry.applied) entry.applied.needsFullValidation = false;
      }
      dirty.clear();
      structureChanged = false;
      if (writeFailure !== null) {
        log.info('memory commit recovered after: ' + describeFailure(writeFailure));
        writeFailure = null;
        lastLoggedWriteError = null;
      }
    } finally {
      exitBusy();
    }
  };

  const bind =
    (owner: string): ApplyMemoryAccessor =>
    (localId, applicationOptions) =>
      apply(owner, localId, applicationOptions) as never;

  const getStatus = (): MemoryManagerStatus => {
    const partitions: MemoryManagerStatus['partitions'] = [];
    for (const bucket of buckets.values())
      for (const entry of bucket.entries.values())
        partitions.push({
          owner: entry.owner,
          localId: entry.localId,
          dataVersion: entry.dataVersion,
          applied: entry.applied !== null,
        });
    return {
      loaded,
      loadError,
      rawWriteError: writeFailure ? describeFailure(writeFailure) : null,
      writeFailure: writeFailure ? { ...writeFailure } : null,
      tick: phaseTick,
      dirty: [...dirty].map((applied) => ({
        owner: applied.entry.owner,
        localId: applied.entry.localId,
      })),
      structureChanged,
      partitions,
      ignoredSegmentPartitions: ignoredSegmentPartitions.map((id) => ({ ...id })),
      preservedRootKeys: [...preservedKeys],
    };
  };

  return { begin, end, bind, getStatus };
};
