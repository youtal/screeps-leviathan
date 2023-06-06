import { profileFunction } from "@/modulesGlobal/Profiler";

const shortcutsCache: ShortcutsCache = {};
const initedRoomNames: Record<string, boolean> = {};

let init = function (roomName) {
  if (initedRoomNames[roomName]) return `Room ${roomName} has been inited.`;
  const targetRoom = Game.rooms[roomName];
  if (!targetRoom) return `Room ${roomName} is not visible.`;
  let cachedMap: CachedMap = {} as any;

  let groupedResult = _.groupBy(
    targetRoom.find(FIND_STRUCTURES),
    "structureType"
  );
  Object.assign(groupedResult, {
    mineral: targetRoom.find(FIND_MINERALS),
    source: targetRoom.find(FIND_SOURCES),
  });

  Object.keys(groupedResult).forEach((key) => {
    cachedMap[key] = groupedResult[key].map((structure) => structure.id);
  });

  shortcutsCache[roomName] = cachedMap as any;
  initedRoomNames[roomName] = true;
};
init = profileFunction(init, "moduleRoomShortcuts");

const updateStructure = function (room: Room, structure: Structure) {
  if (!room) return `Room ${room} is not visible.`;
  //如果该房间还没有被初始化，那么直接返回，等到下次初始化时该建筑会被加入到缓存中
  if (!initedRoomNames[room.name])
    return `Room ${room.name} has not been inited.`;

  const cachedMap = shortcutsCache[room.name];
  if (!cachedMap) return `Room ${room.name} has no cachedMap.`;
  if (!cachedMap[structure.structureType])
    cachedMap[structure.structureType] = [];
  cachedMap[structure.structureType].push(structure.id as any);
};

function createGetter<T extends ALL_CACHED_KEY>(
  room: Room,
  key: T
): CachedObject<T>[];

function createGetter<T extends ALL_CACHED_KEY>(
  room: Room,
  key: T,
  isSingle: boolean
): CachedObject<T>;

function createGetter<T extends ALL_CACHED_KEY>(
  room: Room,
  key: T,
  isSingle?: boolean
): CachedObject<T> | CachedObject<T>[] {
  if (!room) return null;
  if (!initedRoomNames[room.name]) init(room.name);
  const cachedMap = shortcutsCache[room.name];
  if (!cachedMap || !cachedMap[key]) return null;
  if (isSingle) return Game.getObjectById(cachedMap[key][0]) as any;
  return cachedMap[key].map((id) => Game.getObjectById(id)) as any;
}

export const createShortcut = () => {
  return {
    init,
    updateStructure,
    getSpawn: (room: Room) => createGetter(room, STRUCTURE_SPAWN),
    getExtension: (room: Room) => createGetter(room, STRUCTURE_EXTENSION),
    getRoad: (room: Room) => createGetter(room, STRUCTURE_ROAD),
    getWall: (room: Room) => createGetter(room, STRUCTURE_WALL),
    getRampart: (room: Room) => createGetter(room, STRUCTURE_RAMPART),
    getKeeperLair: (room: Room) => createGetter(room, STRUCTURE_KEEPER_LAIR),
    getPortal: (room: Room) => createGetter(room, STRUCTURE_PORTAL),
    getLink: (room: Room) => createGetter(room, STRUCTURE_LINK),
    getLab: (room: Room) => createGetter(room, STRUCTURE_LAB),
    getContainer: (room: Room) => createGetter(room, STRUCTURE_CONTAINER),
    getSource: (room: Room) => createGetter(room, "source"),
    getTower: (room: Room) => createGetter(room, STRUCTURE_TOWER),
    getPowerBank: (room: Room) => createGetter(room, STRUCTURE_POWER_BANK),
    getObserver: (room: Room) => createGetter(room, STRUCTURE_OBSERVER, true),
    getPowerSpawn: (room: Room) =>
      createGetter(room, STRUCTURE_POWER_SPAWN, true),
    getExtractor: (room: Room) => createGetter(room, STRUCTURE_EXTRACTOR, true),
    getNuker: (room: Room) => createGetter(room, STRUCTURE_NUKER, true),
    getMineral: (room: Room) => createGetter(room, "mineral", true),
    getInvaderCore: (room: Room) =>
      createGetter(room, STRUCTURE_INVADER_CORE, true),
    getFactory: (room: Room) => createGetter(room, STRUCTURE_FACTORY, true),
  };
};
