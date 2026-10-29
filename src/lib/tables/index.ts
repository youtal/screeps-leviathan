/**
 * 文件摘要：lib.tables，按 RCL 查询的建筑与控制器常量表（设计见 docs/design/lib/tables.md，架构设计 4.5、10.6、附录 A F16–F17）。
 *
 * 所属位置：src/lib/tables/，lib 层的无状态纯函数与冻结常量。M2 只包含 RCL 相关部分；反应与商品配方随 M6 交付。
 * 数据来源：数值抄自 @screeps/common 2.16.1 的 constants.js，不在运行时读取游戏全局常量，使调用方与测试不依赖全局替身；
 * 单元测试逐项比对在场景镜像中采样的 test/lib/fixtures/engine-constants.json，官方常量变化时重新采样即可发现差异。
 * 对外能力：各 RCL 的建筑数量上限 structureLimit、第 n 个建筑的解锁等级 unlockLevel、能量容量 energyCapacityAt、
 * rampart 血量上限、控制器降级时长与升级所需进度。
 * 表的下标就是 RCL（0–8），查询只做数组下标访问，不分配对象。没有模块级可变状态：所有表都是冻结的。
 */

/** 最高控制器等级。 */
export const MAX_RCL = 8;

/** spawn 的能量容量（`SPAWN_ENERGY_CAPACITY`）。 */
export const SPAWN_CAPACITY = 300;

/** RCL 0–8 各级的上限表：下标为 RCL。 */
type ByRcl = readonly [number, number, number, number, number, number, number, number, number];

/**
 * @description 冻结一张按 RCL 下标的表。
 * @param values RCL 0–8 的 9 个值。
 * @returns 同一数组，已冻结。
 */
const byRcl = (...values: ByRcl): ByRcl => Object.freeze(values);

/**
 * @description 把任意数值规范为表下标 0–8。
 * @param rcl 控制器等级。
 * @returns 0–8 的整数；NaN 按 0。
 */
const clampRcl = (rcl: number): number => {
  if (!(rcl > 0)) return 0;
  return rcl >= MAX_RCL ? MAX_RCL : Math.floor(rcl);
};

/**
 * 各建筑在 RCL 0–8 的数量上限（`CONTROLLER_STRUCTURES`）。
 * { [建筑类型]: 下标为 RCL 的数量上限 }；container 与 road 在所有等级（含 0）都可建造，其余在 RCL 0 为 0。
 */
export const STRUCTURE_LIMITS: Readonly<Record<BuildableStructureConstant, ByRcl>> = Object.freeze({
  spawn: byRcl(0, 1, 1, 1, 1, 1, 1, 2, 3),
  extension: byRcl(0, 0, 5, 10, 20, 30, 40, 50, 60),
  link: byRcl(0, 0, 0, 0, 0, 2, 3, 4, 6),
  road: byRcl(2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500),
  constructedWall: byRcl(0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500),
  rampart: byRcl(0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500),
  storage: byRcl(0, 0, 0, 0, 1, 1, 1, 1, 1),
  tower: byRcl(0, 0, 0, 1, 1, 2, 2, 3, 6),
  observer: byRcl(0, 0, 0, 0, 0, 0, 0, 0, 1),
  powerSpawn: byRcl(0, 0, 0, 0, 0, 0, 0, 0, 1),
  extractor: byRcl(0, 0, 0, 0, 0, 0, 1, 1, 1),
  terminal: byRcl(0, 0, 0, 0, 0, 0, 1, 1, 1),
  lab: byRcl(0, 0, 0, 0, 0, 0, 3, 6, 10),
  container: byRcl(5, 5, 5, 5, 5, 5, 5, 5, 5),
  nuker: byRcl(0, 0, 0, 0, 0, 0, 0, 0, 1),
  factory: byRcl(0, 0, 0, 0, 0, 0, 0, 1, 1),
});

/** 单个 extension 的能量容量（`EXTENSION_ENERGY_CAPACITY`），下标为 RCL。 */
export const EXTENSION_CAPACITY: ByRcl = byRcl(50, 50, 50, 50, 50, 50, 50, 100, 200);

/** rampart 的血量上限（`RAMPART_HITS_MAX`），下标为 RCL；RCL 0–1 不能建 rampart，记为 0。 */
export const RAMPART_MAX_HITS: ByRcl = byRcl(0, 0, 300000, 1000000, 3000000, 10000000, 30000000, 100000000, 300000000);

/** 控制器从满值降级到下一级的 tick 数（`CONTROLLER_DOWNGRADE`），下标为 RCL；RCL 0 没有控制器计时，记为 0。 */
export const DOWNGRADE_TICKS: ByRcl = byRcl(0, 20000, 10000, 20000, 40000, 80000, 120000, 150000, 200000);

/** 从该级升到下一级所需的升级进度（`CONTROLLER_LEVELS`），下标为 RCL；RCL 0 与 8 不能经升级进入下一级，记为 0。 */
export const UPGRADE_PROGRESS: ByRcl = byRcl(0, 200, 45000, 135000, 405000, 1215000, 3645000, 10935000, 0);

/**
 * @description 某种建筑在指定 RCL 下的数量上限。
 * @param type 可建造的建筑类型。
 * @param rcl 控制器等级；小于 0 按 0、大于 8 按 8、非整数向下取整。
 * @returns 数量上限。
 */
export const structureLimit = (type: BuildableStructureConstant, rcl: number): number =>
  STRUCTURE_LIMITS[type][clampRcl(rcl)];

/**
 * @description 第 n 个某类建筑最早在哪一级 RCL 允许存在，供布局规划给每个建筑标注解锁等级（架构 9.6）。
 * @param type 可建造的建筑类型。
 * @param n 第几个，从 1 开始。
 * @returns 最小的 RCL；n 不是正整数或超过 RCL 8 的上限时为 undefined。
 * @example
 * unlockLevel('extension', 6); // 3：RCL 2 只允许 5 个
 */
export const unlockLevel = (type: BuildableStructureConstant, n: number): number | undefined => {
  if (!Number.isInteger(n) || n < 1) return undefined;
  const limits = STRUCTURE_LIMITS[type];
  for (let rcl = 0; rcl <= MAX_RCL; rcl += 1) if (limits[rcl] >= n) return rcl;
  return undefined;
};

/**
 * @description 指定 RCL 下建满 spawn 与 extension 时的能量容量，用于按阶段估算可孵化的体型（架构 10.3）。
 * 不含 power creep 的 `PWR_OPERATE_EXTENSION` 等效果，也不考虑建筑尚未建成的情形。
 * @param rcl 控制器等级，取值处理同 structureLimit。
 * @returns 能量容量。
 */
export const energyCapacityAt = (rcl: number): number => {
  const r = clampRcl(rcl);
  return STRUCTURE_LIMITS.spawn[r] * SPAWN_CAPACITY + STRUCTURE_LIMITS.extension[r] * EXTENSION_CAPACITY[r];
};
