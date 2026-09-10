/**
 * 文件摘要：声明 RoomShortcuts 的创建选项、缓存键和键到对象/id 的类型映射。
 *
 * 模块位置：src/modules/roomShortcuts 的类型契约，被 createRoomShortcuts.ts 与
 * test/roomShortcuts.test.ts 引用。模块在 app 层以 roomShortcutsPlugin 注册，并把工厂
 * 返回值发布为服务 'roomShortcuts'，因此这些类型同时约束实现与使用方。
 *
 * 主要输入 / 输出：RoomShortcutsOpt 描述工厂入参（模块上下文加两个可选开关）；
 * ALL_CACHED_KEY、CachedObject、CachedMap 给出 getter 泛型查询的“键 -> 值”对应关系；
 * ShortcutsCache 描述闭包内缓存的静态形状。运行时能力全部由 createRoomShortcuts 返回。
 *
 * 状态与副作用：映射类型把 Screeps 的 structureType 常量与 ConcreteStructureMap 对齐，并将
 * Source、Mineral 作为额外类别加入同一泛型查询协议。这些类型只参与编译检查，不为缓存增加
 * 运行时字段；文件末尾集中导出的符号全部是类型，编译后本文件不产生任何 JS 导出。
 */
import type { ModuleContext } from '@/core/runtime/types';

/**
 * 创建参数继承模块上下文，并允许控制强制刷新和 tick 租约长度。
 *
 * 继承来的上下文中，bus 用于订阅全局建筑事件，env 提供可替换的 Game 访问与模块日志，
 * profiler 可选（工厂当前未包裹任何统计）。
 * - forceReInit：诊断与测试开关，开启后每次 getter 都重扫房间，等价于放弃缓存收益。
 * - cacheLeaseTicks：缓存租约长度，单位 tick；缺省 5000，实现会做有限性与下界归一化。
 */
interface RoomShortcutsOpt extends ModuleContext {
  forceReInit?: boolean;
  cacheLeaseTicks?: number;
}

/**
 * 本模块允许缓存的全部 Screeps 建筑类型常量联合。
 *
 * 它同时是缓存键与 CachedMap 的键集合：枚举出“房间扫描可能产出且值得缓存”的建筑类别，
 * 使后续所有映射都能在编译期穷尽检查。STRUCTURE_CONTROLLER 虽然在此列表中，
 * 但 FIND_STRUCTURES 不会返回控制器，工厂也没有对应 getter，因此该类别当前始终为空。
 */
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

/**
 * Source/Mineral 不是 structureType 常量，因此用 `as const` 固定字符串字面量，
 * 再借“值空间 const 与类型空间 type 同名”的声明合并，让 `SOURCE_KEY` 既能当缓存键的
 * 运行时字符串，又能作为字面量类型参与映射。这样资源节点与建筑共用同一套查询协议。
 */
const SOURCE_KEY = 'source' as const;
const MINERAL_KEY = 'mineral' as const;
// 预留：未来若缓存房间中心点，可在此引入 center 键。
type SOURCE_KEY = typeof SOURCE_KEY;
type MINERAL_KEY = typeof MINERAL_KEY;
// 预留的 center 键还未进入公共类型协议。
type CACHED_RESOURCE_KEY = SOURCE_KEY | MINERAL_KEY;
// 若启用 center 缓存，需要把它加入 ALL_CACHED_KEY。
type ALL_CACHED_KEY = STRUCTURE_KEY | CACHED_RESOURCE_KEY;

/**
 * 缓存键到“实际对象类型”的映射：建筑部分直接复用 @types/screeps 的 ConcreteStructureMap，
 * 再补上 Source/Mineral 两个非建筑类别。CachedObject 通过泛型索引访问做一次键到值的翻译，
 * 让 getter 的返回类型随传入键自动收窄。
 */
interface CachedObjectMap extends ConcreteStructureMap {
  [SOURCE_KEY]: Source;
  [MINERAL_KEY]: Mineral;
  // 预留的 center 值类型应为 RoomPosition。
}

/** 键联合到对象类型的索引访问；T 为多个键时结果为对应的对象类型联合。 */
type CachedObject<T extends ALL_CACHED_KEY> = CachedObjectMap[T];

/**
 * 每个缓存类别对应的具体 Screeps id 数组类型。
 *
 * 这里手写而非从 CachedObjectMap 推导，因为缓存保存的是 `Id<具体结构>`，而不是结构实例；
 * 手写清单的代价是新增类别要同步维护，收益是 ShortcutsCache 的映射类型会在漏项时直接报错，
 * 从而把“枚举与缓存表不同步”变成编译期问题。
 */
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

/**
 * 外层按房间名分组；Partial 表示房间可能不存在某些建筑类别。
 *
 * 键缺失（房间没有该类别）与空数组在语义上等价，getter 会同时处理这两种形态并统一
 * 返回空结果；缓存本身只保存 id，避免跨 tick 长期持有 RoomObject 实例。
 */
interface ShortcutsCache {
  [roomName: string]: Partial<{
    [key in ALL_CACHED_KEY]: CachedMap[key];
  }>;
}

/**
 * 集中导出本文件的类型契约。这里全部是类型（无运行时值），因此编译产物不会导出任何东西；
 * 使用方按需从本模块类型导入即可，不必依赖 createRoomShortcuts.ts 的内部结构。
 */
export {
  RoomShortcutsOpt,
  CachedObject,
  ALL_CACHED_KEY,
  ShortcutsCache,
  CachedMap,
  STRUCTURE_KEY,
};
