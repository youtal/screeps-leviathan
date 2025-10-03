import { EnvContext, Bus } from '@/utils';

interface RoomShortcutsOpt extends EnvContext {
  bus: Bus;
  forceReInit?: boolean;
}

type STRUCTURE_KEY =
  | STRUCTURE_OBSERVER
  | STRUCTURE_POWER_SPAWN
  | STRUCTURE_EXTRACTOR
  | STRUCTURE_NUKER
  | STRUCTURE_FACTORY
  | STRUCTURE_CONTROLLER
  | STRUCTURE_SPAWN
  | STRUCTURE_EXTENSION
  | STRUCTURE_ROAD
  | STRUCTURE_WALL
  | STRUCTURE_RAMPART
  | STRUCTURE_KEEPER_LAIR
  | STRUCTURE_LINK
  | STRUCTURE_TOWER
  | STRUCTURE_LAB
  | STRUCTURE_CONTAINER
  | STRUCTURE_PORTAL
  | STRUCTURE_INVADER_CORE
  | STRUCTURE_STORAGE
  | STRUCTURE_TERMINAL
  | STRUCTURE_POWER_BANK;

const SOURCE_KEY = 'source' as const;
const MINERAL_KEY = 'mineral' as const;
//const CENTER_KEY = 'center' as const;
type SOURCE_KEY = typeof SOURCE_KEY;
type MINERAL_KEY = typeof MINERAL_KEY;
//type CENTER_KEY = typeof CENTER_KEY;
type CACHED_RESOURCE_KEY = SOURCE_KEY | MINERAL_KEY;
//type ALL_CACHED_KEY = STRUCTURE_KEY | CACHED_RESOURCE_KEY | CENTER_KEY;
type ALL_CACHED_KEY = STRUCTURE_KEY | CACHED_RESOURCE_KEY;

interface CachedObjectMap extends ConcreteStructureMap {
  [SOURCE_KEY]: Source;
  [MINERAL_KEY]: Mineral;
  //  [CENTER_KEY]: RoomPosition;
}

type CachedObject<T extends ALL_CACHED_KEY> = CachedObjectMap[T];

interface CachedMap {
  [STRUCTURE_EXTENSION]: Id<StructureExtension>[];
  [STRUCTURE_RAMPART]: Id<StructureRampart>[];
  [STRUCTURE_ROAD]: Id<StructureRoad>[];
  [STRUCTURE_SPAWN]: Id<StructureSpawn>[];
  [STRUCTURE_LINK]: Id<StructureLink>[];
  [STRUCTURE_WALL]: Id<StructureWall>[];
  [STRUCTURE_STORAGE]: Id<StructureStorage>[];
  [STRUCTURE_TOWER]: Id<StructureTower>[];
  [STRUCTURE_OBSERVER]: Id<StructureObserver>[];
  [STRUCTURE_POWER_SPAWN]: Id<StructurePowerSpawn>[];
  [STRUCTURE_EXTRACTOR]: Id<StructureExtractor>[];
  [STRUCTURE_LAB]: Id<StructureLab>[];
  [STRUCTURE_TERMINAL]: Id<StructureTerminal>[];
  [STRUCTURE_CONTAINER]: Id<StructureContainer>[];
  [STRUCTURE_NUKER]: Id<StructureNuker>[];
  [STRUCTURE_FACTORY]: Id<StructureFactory>[];
  [STRUCTURE_KEEPER_LAIR]: Id<StructureKeeperLair>[];
  [STRUCTURE_CONTROLLER]: Id<StructureController>[];
  [STRUCTURE_POWER_BANK]: Id<StructurePowerBank>[];
  [STRUCTURE_PORTAL]: Id<StructurePortal>[];
  [STRUCTURE_INVADER_CORE]: Id<StructureInvaderCore>[];
  [SOURCE_KEY]: Id<Source>[];
  [MINERAL_KEY]: Id<Mineral>[];
  //  [CENTER_KEY]: [number, number];
}

interface ShortcutsCache {
  [roomName: string]: {
    [key in ALL_CACHED_KEY]: CachedMap[key];
  };
}

export {
  RoomShortcutsOpt,
  CachedObject,
  ALL_CACHED_KEY,
  ShortcutsCache,
  CachedMap,
  STRUCTURE_KEY,
};
