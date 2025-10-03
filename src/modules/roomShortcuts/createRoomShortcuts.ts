import { bus } from '@/instance';
import {
  RoomShortcutsOpt,
  ShortcutsCache,
  CachedMap,
  STRUCTURE_KEY,
  ALL_CACHED_KEY,
  CachedObject,
} from './types';
import { eventList } from '@/utils/eventBus/constants';

export const createRoomShortcuts = (opt: RoomShortcutsOpt) => {
  const { getRoom, getObjectById, log } = opt.env;
  const { forceReInit = false } = opt;

  const initedRooms: { [roomName: string]: boolean } = {};
  const shortcutsCache: ShortcutsCache = {};

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

    const cache: CachedMap = {} as any;

    //将房间内的所有建筑按类型分组
    const grouped = _.groupBy(room.find(FIND_STRUCTURES), 'structureType');
    Object.assign(grouped, {
      source: room.find(FIND_SOURCES),
      mineral: room.find(FIND_MINERALS),
    });

    //将各结构id存入缓存
    Object.keys(grouped).forEach((key) => {
      cache[key] = grouped[key].map((s) => s.id);
    });

    //更新缓存
    shortcutsCache[roomName] = cache;
    initedRooms[roomName] = true;
    //订阅建筑建造事件
    bus.subscribe(
      eventList.structureBuilt,
      'roomShortcuts',
      (data) => updateStructure(data.structureId),
      roomName
    );
    log.info(`Room ${roomName} shortcuts initialized.`);
  };

  //更新建筑至缓存中,用于监听建筑建造事件
  const updateStructure = (id: Id<Structure>) => {
    const obj = getObjectById(id);
    if (!obj) {
      log.error(`Object with id ${id} not found, cannot update shortcuts.`);
      return;
    }

    const { roomName } = obj.pos;

    if (!initedRooms[roomName]) {
      log.info(`Room ${roomName} not initialized, cannot update shortcuts.`);
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
  ): CachedObject<K> | CachedObject<K>[] => {
    //先检查房间是否有视野
    if (!getRoom(roomName)) {
      log.error(
        `no visual on Room ${roomName}, structure shortcuts unavailable.`
      );
      return isSingle ? undefined : null;
    }
    //检查房间是否初始化
    if (!initedRooms[roomName]) {
      log.info(`Room ${roomName} cache missed, initializing now.`);
      init(roomName);
    }

    //拿到缓存
    const cacheMap = shortcutsCache[roomName];
    if (!cacheMap) {
      log.error(`an error occurred, room ${roomName} has no cacheMap.`);
      return isSingle ? undefined : null;
    }

    if (!cacheMap[key] || cacheMap[key].length === 0) {
      log.warn(`no structure ${key} was found in room ${roomName}.`);
      return isSingle ? undefined : null;
    }
    //根据缓存id返回对象
    return isSingle
      ? (getObjectById(cacheMap[key][0]) as CachedObject<K>)
      : (cacheMap[key].map((id) => getObjectById(id)) as CachedObject<K>[]);
  };

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
      createGetter(STRUCTURE_OBSERVER, roomName, true) as StructureObserver,
    getPowerSpawn: (roomName: string) =>
      createGetter(
        STRUCTURE_POWER_SPAWN,
        roomName,
        true
      ) as StructurePowerSpawn,
    getExtractor: (roomName: string) =>
      createGetter(STRUCTURE_EXTRACTOR, roomName, true) as StructureExtractor,
    getNuker: (roomName: string) =>
      createGetter(STRUCTURE_NUKER, roomName, true) as StructureNuker,
    getFactory: (roomName: string) =>
      createGetter(STRUCTURE_FACTORY, roomName, true) as StructureFactory,
    getStorage: (roomName: string) =>
      createGetter(STRUCTURE_STORAGE, roomName, true) as StructureStorage,
    getTerminal: (roomName: string) =>
      createGetter(STRUCTURE_TERMINAL, roomName, true) as StructureTerminal,
    getInVaderCore: (roomName: string) =>
      createGetter(
        STRUCTURE_INVADER_CORE,
        roomName,
        true
      ) as StructureInvaderCore,
    getSource: (roomName: string) =>
      createGetter('source', roomName) as Source[],
    getMineral: (roomName: string) =>
      createGetter('mineral', roomName, true) as Mineral,
  };
};
