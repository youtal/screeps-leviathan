type StructureShortcutKey =
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

type SOURCE_KEY = "source";
type MINERAL_KEY = "mineral";
type CachedResourceKey = SOURCE_KEY | MINERAL_KEY;
declare const SourceKey: SOURCE_KEY;
declare const MineralKey: MINERAL_KEY;
type ALL_CACHED_KEY = StructureShortcutKey | CachedResourceKey;

interface CachedObjectMap extends ConcreteStructureMap {
  [SourceKey]: Source;
  [MineralKey]: Mineral;
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
  [SourceKey]: Id<Source>[];
  [MineralKey]: Id<Mineral>[];
}

interface ShortcutsCache {
  [roomName: string]: {
    [key in ALL_CACHED_KEY]: CachedMap[key];
  };
}

interface Room {
  STRUCTURE_EXTENSION: StructureExtension[];
  STRUCTURE_RAMPART: StructureRampart[];
  STRUCTURE_ROAD: StructureRoad[];
  STRUCTURE_SPAWN: StructureSpawn[];
  STRUCTURE_LINK: StructureLink[];
  STRUCTURE_WALL: StructureWall[];
  STRUCTURE_TOWER: StructureTower[];
  STRUCTURE_OBSERVER: StructureObserver;
  STRUCTURE_POWER_SPAWN: StructurePowerSpawn;
  STRUCTURE_EXTRACTOR: StructureExtractor;
  STRUCTURE_LAB: StructureLab[];
  STRUCTURE_CONTAINER: StructureContainer[];
  STRUCTURE_NUKER: StructureNuker;
  STRUCTURE_FACTORY: StructureFactory;
  STRUCTURE_KEEPER_LAIR: StructureKeeperLair[];
  STRUCTURE_POWER_BANK: StructurePowerBank;
  STRUCTURE_PORTAL: StructurePortal[];
  STRUCTURE_INVADER_CORE: StructureInvaderCore;
  source: Source[];
  mineral: Mineral;
}

//type ShortcutsCache<T extends ALL_CACHED_KEY> = Record<T, CachedMap[T]>;
