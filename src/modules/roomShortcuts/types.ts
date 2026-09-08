/**
 * 文件摘要：声明 RoomShortcuts 的创建选项、缓存键和键到对象/id 的类型映射。
 *
 * 映射类型把 Screeps 的 structureType 常量与 ConcreteStructureMap 对齐，并将
 * Source、Mineral 作为额外类别加入同一泛型查询协议。这些类型只参与编译检查，
 * 不为缓存增加运行时字段。
 */
import type { ModuleContext } from '@/core/runtime/types';

/** 创建参数继承模块上下文，并允许控制强制刷新和 tick 租约长度。 */
interface RoomShortcutsOpt extends ModuleContext {
  forceReInit?: boolean;
  cacheLeaseTicks?: number;
}

/** 本模块允许缓存的全部 Screeps 建筑类型常量联合。 */
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
// 预留：未来若缓存房间中心点，可在此引入 center 键。
type SOURCE_KEY = typeof SOURCE_KEY;
type MINERAL_KEY = typeof MINERAL_KEY;
// 预留的 center 键还未进入公共类型协议。
type CACHED_RESOURCE_KEY = SOURCE_KEY | MINERAL_KEY;
// 若启用 center 缓存，需要把它加入 ALL_CACHED_KEY。
type ALL_CACHED_KEY = STRUCTURE_KEY | CACHED_RESOURCE_KEY;

interface CachedObjectMap extends ConcreteStructureMap {
  [SOURCE_KEY]: Source;
  [MINERAL_KEY]: Mineral;
  // 预留的 center 值类型应为 RoomPosition。
}

type CachedObject<T extends ALL_CACHED_KEY> = CachedObjectMap[T];

/** 每个缓存类别对应的具体 Screeps id 数组类型。 */
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
  // center 若落地，可使用坐标元组避免缓存 RoomPosition 实例。
}

/** 外层按房间名分组；Partial 表示房间可能不存在某些建筑类别。 */
interface ShortcutsCache {
  [roomName: string]: Partial<{
    [key in ALL_CACHED_KEY]: CachedMap[key];
  }>;
}

export {
  RoomShortcutsOpt,
  CachedObject,
  ALL_CACHED_KEY,
  ShortcutsCache,
  CachedMap,
  STRUCTURE_KEY,
};
