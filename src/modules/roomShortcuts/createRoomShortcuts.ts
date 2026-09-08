import {
  RoomShortcutsOpt,
  ShortcutsCache,
  CachedMap,
  STRUCTURE_KEY,
  ALL_CACHED_KEY,
  CachedObject,
} from './types';

export const createRoomShortcuts = (opt: RoomShortcutsOpt) => {
  const { bus } = opt;
  const { getGame, getRoom, getObjectById, log } = opt.env;
  const { forceReInit = false, cacheLeaseTicks = 5000 } = opt;
  const normalizedCacheLeaseTicks = Number.isFinite(cacheLeaseTicks)
    ? Math.max(1, Math.floor(cacheLeaseTicks))
    : 5000;

  const initedRooms: { [roomName: string]: boolean } = {};
  const initializedAt: { [roomName: string]: number } = {};
  const shortcutsCache: ShortcutsCache = {};

  const invalidate = (roomName: string): void => {
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

    const index = cachedIds.indexOf(structureId);
    if (index !== -1) {
      cachedIds.splice(index, 1);
      log.info(
        `Destroyed structure ${structureId} removed from shortcuts: ${roomName} ${structureType}.`
      );
    }
  };

  //初始化房间，将各结构id存入缓存
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

    //将房间内的所有建筑按类型分组
    const grouped = {
      ...(_.groupBy(room.find(FIND_STRUCTURES), 'structureType') as Partial<
        Record<STRUCTURE_KEY, Structure[]>
      >),
      source: room.find(FIND_SOURCES),
      mineral: room.find(FIND_MINERALS),
    };

    //将各结构id存入缓存
    const setCache = <K extends keyof CachedMap>(key: K, ids: CachedMap[K]) => {
      cache[key] = ids;
    };

    (Object.keys(grouped) as (keyof typeof grouped)[]).forEach((key) => {
      setCache(key, grouped[key]!.map((s) => s.id) as CachedMap[typeof key]);
    });

    //更新缓存
    shortcutsCache[roomName] = cache;
    initedRooms[roomName] = true;
    initializedAt[roomName] = getGame().time;
    log.info(`Room ${roomName} shortcuts initialized.`);
  };

  //更新建筑至缓存中,用于监听建筑建造事件
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
    //先检查房间是否有视野
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

    //检查房间是否初始化或租约是否到期
    if (!initedRooms[roomName] || forceReInit || leaseExpired) {
      log.info(
        `Room ${roomName} cache ${forceReInit ? 'refresh requested' : leaseExpired ? 'lease expired' : 'missed'}, initializing now.`
      );
      init(roomName, forceReInit || leaseExpired);
    }

    //拿到缓存
    const cacheMap = shortcutsCache[roomName];
    if (!cacheMap) {
      log.error(`an error occurred, room ${roomName} has no cacheMap.`);
      return isSingle ? undefined : [];
    }

    if (!cacheMap[key] || cacheMap[key].length === 0) {
      return isSingle ? undefined : [];
    }
    //根据缓存id返回对象
    if (isSingle) {
      return (
        (getObjectById(cacheMap[key][0]) as CachedObject<K> | null) ?? undefined
      );
    }

    return cacheMap[key]
      .map((id) => getObjectById(id) as CachedObject<K> | null)
      .filter((object): object is CachedObject<K> => object !== null);
  };

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
