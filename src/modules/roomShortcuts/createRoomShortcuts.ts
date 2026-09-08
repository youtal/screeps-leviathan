/**
 * 文件摘要：按房间缓存建筑、Source 与 Mineral 的 id，并提供强类型快捷查询。
 *
 * 模块使用闭包保存按房间分组的堆内缓存，以一次 FIND 查询换取租约期间的低成本
 * `Game.getObjectById` 查询。全局建筑建成和毁坏事件用于增量维护缓存；固定 tick
 * 租约及视野丢失时的主动失效负责兜底，避免事件遗漏让陈旧数据长期存活。
 */
import {
  RoomShortcutsOpt,
  ShortcutsCache,
  CachedMap,
  STRUCTURE_KEY,
  ALL_CACHED_KEY,
  CachedObject,
} from './types';

export const createRoomShortcuts = (opt: RoomShortcutsOpt) => {
  /** Runtime 提供共享总线；env 提供可替换的 Game 查询和模块日志。 */
  const { bus } = opt;
  const { getGame, getRoom, getObjectById, log } = opt.env;
  const { forceReInit = false, cacheLeaseTicks = 5000 } = opt;
  const normalizedCacheLeaseTicks = Number.isFinite(cacheLeaseTicks)
    ? Math.max(1, Math.floor(cacheLeaseTicks))
    : 5000;

  /**
   * 三个对象以 roomName 使用同一索引：初始化标记控制快速判断，时间戳用于
   * 计算租约，shortcutsCache 保存实际 id 数组。它们都只存在于当前全局实例。
   */
  const initedRooms: { [roomName: string]: boolean } = {};
  const initializedAt: { [roomName: string]: number } = {};
  const shortcutsCache: ShortcutsCache = {};

  const invalidate = (roomName: string): void => {
    /** 删除同一房间的全部关联状态，使下一次 getter 必须执行完整初始化。 */
    if (!initedRooms[roomName] && !shortcutsCache[roomName]) return;

    delete shortcutsCache[roomName];
    delete initedRooms[roomName];
    delete initializedAt[roomName];
    log.info(`Room ${roomName} shortcuts invalidated.`);
  };

  const removeDestroyedStructure = (
    roomName: string,
    structureId: Id<Structure>,
    ruinId: Id<Ruin>
  ): void => {
    /**
     * 双 id 协议用 `ruinId` 找到废墟中的原建筑类型，再用 `structureId` 校验
     * 消息指向同一对象。任何无法验证的情况都整房失效，防止误删其他缓存项。
     */
    if (!initedRooms[roomName]) return;

    const ruin = getObjectById(ruinId);
    if (!ruin) {
      log.warn(
        `Ruin ${ruinId} not found; invalidating shortcuts for room ${roomName}.`
      );
      invalidate(roomName);
      return;
    }

    if (ruin.pos.roomName !== roomName) {
      log.warn(
        `Ruin ${ruinId} belongs to room ${ruin.pos.roomName}, not subscribed room ${roomName}; invalidating shortcuts.`
      );
      invalidate(roomName);
      return;
    }

    if (ruin.structure.id !== structureId) {
      log.warn(
        `Destroyed structure ${structureId} does not match ruin ${ruinId} (${ruin.structure.id}) in room ${roomName}; invalidating shortcuts.`
      );
      invalidate(roomName);
      return;
    }

    const structureType = ruin.structure.structureType as STRUCTURE_KEY;
    const cachedIds = shortcutsCache[roomName]?.[structureType] as
      Id<Structure>[] | undefined;
    if (!cachedIds) return;

    /** 原地删除能保留该类型数组引用，避免为一次事件复制整个数组。 */
    const index = cachedIds.indexOf(structureId);
    if (index !== -1) {
      cachedIds.splice(index, 1);
      log.info(
        `Destroyed structure ${structureId} removed from shortcuts: ${roomName} ${structureType}.`
      );
    }
  };

  /**
   * 扫描有视野房间并重建全部快捷索引。
   *
   * `room.find` 是本模块的主要 CPU 成本，因此只在首次查询、强制刷新或租约
   * 到期时执行。建筑先由 lodash 按 structureType 分组，资源节点随后合并到
   * 同一索引，最终只缓存 id，避免跨 tick 长期持有失效的 RoomObject 引用。
   */
  const init = (roomName: string, force: boolean = forceReInit) => {
    const room = getRoom(roomName);
    if (!room) {
      log.error(`Room ${roomName} not found, cannot initialize shortcuts.`);
      return;
    }

    if (initedRooms[roomName] && !force) {
      log.info(`Room ${roomName} already initialized, skipping.`);
      return;
    } else if (initedRooms[roomName] && force) {
      log.info(
        `Room ${roomName} already initialized, but force re-initializing.`
      );
    }

    const cache: Partial<CachedMap> = {};

    /** 将房间建筑按类型分组，并把 Source、Mineral 作为虚拟缓存类别合并。 */
    const grouped = {
      ...(_.groupBy(room.find(FIND_STRUCTURES), 'structureType') as Partial<
        Record<STRUCTURE_KEY, Structure[]>
      >),
      source: room.find(FIND_SOURCES),
      mineral: room.find(FIND_MINERALS),
    };

    /** 泛型辅助函数保持 key 与对应 id 数组类型的关联。 */
    const setCache = <K extends keyof CachedMap>(key: K, ids: CachedMap[K]) => {
      cache[key] = ids;
    };

    (Object.keys(grouped) as (keyof typeof grouped)[]).forEach((key) => {
      setCache(key, grouped[key]!.map((s) => s.id) as CachedMap[typeof key]);
    });

    /** 完成全部映射后再整体发布缓存，避免查询方看到半初始化状态。 */
    shortcutsCache[roomName] = cache;
    initedRooms[roomName] = true;
    initializedAt[roomName] = getGame().time;
    log.info(`Room ${roomName} shortcuts initialized.`);
  };

  /**
   * 响应建筑建造完成事件，对已经初始化的房间执行增量追加。
   *
   * 未初始化房间无需更新，因为它首次查询时会扫描当前真实状态；对象缺失、
   * 房间不匹配等协议异常会触发整房失效，等待后续查询自愈。
   */
  const updateStructure = (roomName: string, id: Id<Structure>) => {
    if (!initedRooms[roomName]) {
      log.info(`Room ${roomName} not initialized, cannot update shortcuts.`);
      return;
    }

    const obj = getObjectById(id);
    if (!obj) {
      log.error(`Object with id ${id} not found, cannot update shortcuts.`);
      invalidate(roomName);
      return;
    }

    if (obj.pos.roomName !== roomName) {
      log.warn(
        `Built structure ${id} belongs to room ${obj.pos.roomName}, not event room ${roomName}; invalidating shortcuts.`
      );
      invalidate(roomName);
      return;
    }

    const structureType = obj.structureType as STRUCTURE_KEY;
    if (shortcutsCache[roomName][structureType] === undefined) {
      shortcutsCache[roomName][structureType] = [];
    }

    if (shortcutsCache[roomName][structureType].includes(id as any)) {
      log.warn(`Structure with id ${id} already in shortcuts, skipping.`);
      return;
    }

    shortcutsCache[roomName][structureType].push(id as any);
    log.info(
      `Structure with id ${id} added to shortcuts: ${roomName} ${structureType}.`
    );
  };

  const createGetter = <K extends ALL_CACHED_KEY>(
    key: K,
    roomName: string,
    isSingle?: boolean
  ): CachedObject<K> | CachedObject<K>[] | undefined => {
    /**
     * 所有公共 getter 的统一读取路径。
     *
     * 无视野时无法验证缓存，立即失效并返回稳定空值；有视野时按初始化状态、
     * `forceReInit` 与 tick 租约决定是否重扫。单对象查询以 undefined 表示无结果，
     * 多对象查询以空数组表示无结果，使调用方无需额外判断 null。
     */
    if (!getRoom(roomName)) {
      log.error(
        `no visual on Room ${roomName}, structure shortcuts unavailable.`
      );
      invalidate(roomName);
      return isSingle ? undefined : [];
    }
    const leaseExpired =
      !forceReInit &&
      initedRooms[roomName] &&
      getGame().time - initializedAt[roomName] >= normalizedCacheLeaseTicks;

    /** 缓存缺失、显式强制刷新或租约到期都会进入同一初始化路径。 */
    if (!initedRooms[roomName] || forceReInit || leaseExpired) {
      log.info(
        `Room ${roomName} cache ${forceReInit ? 'refresh requested' : leaseExpired ? 'lease expired' : 'missed'}, initializing now.`
      );
      init(roomName, forceReInit || leaseExpired);
    }

    /** 初始化失败时缓存可能仍不存在，此处返回与查询形态一致的空结果。 */
    const cacheMap = shortcutsCache[roomName];
    if (!cacheMap) {
      log.error(`an error occurred, room ${roomName} has no cacheMap.`);
      return isSingle ? undefined : [];
    }

    if (!cacheMap[key] || cacheMap[key].length === 0) {
      return isSingle ? undefined : [];
    }
    /**
     * 单对象类别读取首个 id；数组类别逐个解析并滤掉已失效对象。
     * 类型谓词让 filter 后的数组从 `(CachedObject | null)[]` 收窄为对象数组。
     */
    if (isSingle) {
      return (
        (getObjectById(cacheMap[key][0]) as CachedObject<K> | null) ?? undefined
      );
    }

    return cacheMap[key]
      .map((id) => getObjectById(id) as CachedObject<K> | null)
      .filter((object): object is CachedObject<K> => object !== null);
  };

  /**
   * 模块是全局缓存管理器，因此仅在创建时各订阅一次全局建筑事件；事件中的
   * roomName 决定具体更新哪个房间，避免为每个已访问房间重复注册监听器。
   */
  bus.subscribe(
    { scope: 'global' },
    'structure:built',
    'roomShortcuts',
    (data) => updateStructure(data.roomName, data.structureId)
  );
  bus.subscribe(
    { scope: 'global' },
    'structure:destroyed',
    'roomShortcuts',
    (data) =>
      removeDestroyedStructure(data.roomName, data.structureId, data.ruinId)
  );

  /**
   * 公共快捷方法只负责固定缓存 key 和单值/数组语义，生命周期与校验逻辑全部
   * 收敛在 createGetter 中。类型断言把通用泛型返回值呈现为 Screeps 具体对象。
   */
  return {
    getSpawn: (roomName: string) =>
      createGetter(STRUCTURE_SPAWN, roomName) as StructureSpawn[],
    getExtension: (roomName: string) =>
      createGetter(STRUCTURE_EXTENSION, roomName) as StructureExtension[],
    getRampart: (roomName: string) =>
      createGetter(STRUCTURE_RAMPART, roomName) as StructureRampart[],
    getRoad: (roomName: string) =>
      createGetter(STRUCTURE_ROAD, roomName) as StructureRoad[],
    getWall: (roomName: string) =>
      createGetter(STRUCTURE_WALL, roomName) as StructureWall[],
    getKeeperLair: (roomName: string) =>
      createGetter(STRUCTURE_KEEPER_LAIR, roomName) as StructureKeeperLair[],
    getPortal: (roomName: string) =>
      createGetter(STRUCTURE_PORTAL, roomName) as StructurePortal[],
    getLink: (roomName: string) =>
      createGetter(STRUCTURE_LINK, roomName) as StructureLink[],
    getLab: (roomName: string) =>
      createGetter(STRUCTURE_LAB, roomName) as StructureLab[],
    getContainer: (roomName: string) =>
      createGetter(STRUCTURE_CONTAINER, roomName) as StructureContainer[],
    getTower: (roomName: string) =>
      createGetter(STRUCTURE_TOWER, roomName) as StructureTower[],
    getPowerBank: (roomName: string) =>
      createGetter(STRUCTURE_POWER_BANK, roomName) as StructurePowerBank[],
    getObserver: (roomName: string) =>
      createGetter(STRUCTURE_OBSERVER, roomName, true) as
        StructureObserver | undefined,
    getPowerSpawn: (roomName: string) =>
      createGetter(STRUCTURE_POWER_SPAWN, roomName, true) as
        StructurePowerSpawn | undefined,
    getExtractor: (roomName: string) =>
      createGetter(STRUCTURE_EXTRACTOR, roomName, true) as
        StructureExtractor | undefined,
    getNuker: (roomName: string) =>
      createGetter(STRUCTURE_NUKER, roomName, true) as
        StructureNuker | undefined,
    getFactory: (roomName: string) =>
      createGetter(STRUCTURE_FACTORY, roomName, true) as
        StructureFactory | undefined,
    getStorage: (roomName: string) =>
      createGetter(STRUCTURE_STORAGE, roomName, true) as
        StructureStorage | undefined,
    getTerminal: (roomName: string) =>
      createGetter(STRUCTURE_TERMINAL, roomName, true) as
        StructureTerminal | undefined,
    getInVaderCore: (roomName: string) =>
      createGetter(STRUCTURE_INVADER_CORE, roomName, true) as
        StructureInvaderCore | undefined,
    getSource: (roomName: string) =>
      createGetter('source', roomName) as Source[],
    getMineral: (roomName: string) =>
      createGetter('mineral', roomName, true) as Mineral | undefined,
  };
};
