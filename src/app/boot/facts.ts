/**
 * 文件摘要：app.boot 的世界事实读取（设计见 docs/design/app/boot.md 第 2、5 节，架构设计 11.3）。
 *
 * 所属位置：src/app/boot/，app.boot 内部。把 Game 中启动判定需要的对象整理为纯数据：完整判定时读取 BootFacts，
 * 平时每 tick 只读取三个计数（BootCounts）作为廉价不变量。判定逻辑（assess.ts）只接收这些纯数据，不读 Game。
 * 装配方以 readGameFacts、readGameCounts 注入游戏实现，测试中替换为构造的数据。
 * 无模块级状态；每次调用读取当 tick 的 Game 并新建结果对象。
 */

/** 一个本方 controller 的事实。 */
export interface ControllerFact {
  readonly room: string;
  readonly level: number;
  readonly progress: number;
  /** safe mode 剩余 tick（F3）；未开启时为 undefined。 */
  readonly safeMode: number | undefined;
}

/** 完整判定使用的世界事实（11.3）。 */
export interface BootFacts {
  readonly time: number;
  /** 本方 spawn 的 id 与所在房间。 */
  readonly spawns: readonly { readonly id: string; readonly room: string }[];
  /** Game.structures 的数量：本方 OwnedStructure，含 controller（F4）。 */
  readonly structCount: number;
  /** 其中 spawn 与 controller 以外的数量（11.5 的 nonCore）。 */
  readonly nonCoreCount: number;
  /** Game.constructionSites 的数量。 */
  readonly sites: number;
  /** 本 shard 的 creep 数。 */
  readonly creepCount: number;
  /** 本 shard 中已生成的 PowerCreep 数（11.4 W3 的 pcHere）。 */
  readonly pcHere: number;
  /** 本方 controller。 */
  readonly controllers: readonly ControllerFact[];
}

/** 每 tick 读取的廉价不变量（11.1）。 */
export interface BootCounts {
  readonly spawns: number;
  readonly structures: number;
  readonly creeps: number;
}

/**
 * @description 从 Game 读取完整判定所需的事实；只在完整判定的 tick 与指纹更新时调用。
 * @returns 本 tick 的事实。
 */
export const readGameFacts = (): BootFacts => {
  const spawns: { id: string; room: string }[] = [];
  const controllers: ControllerFact[] = [];
  let structCount = 0;
  let nonCoreCount = 0;
  for (const id in Game.structures) {
    const s = Game.structures[id];
    structCount += 1;
    if (s.structureType === STRUCTURE_SPAWN) {
      spawns.push({ id: s.id, room: s.room.name });
    } else if (s.structureType === STRUCTURE_CONTROLLER) {
      const c = s as StructureController;
      controllers.push({ room: c.room.name, level: c.level, progress: c.progress, safeMode: c.safeMode });
    } else {
      nonCoreCount += 1;
    }
  }
  let pcHere = 0;
  // 私服可能没有 PowerCreep 表；room 为 undefined 表示尚未在本 shard 生成。
  for (const name in Game.powerCreeps ?? {}) if (Game.powerCreeps[name].room !== undefined) pcHere += 1;
  return {
    time: Game.time, spawns, structCount, nonCoreCount,
    sites: Object.keys(Game.constructionSites).length,
    creepCount: Object.keys(Game.creeps).length,
    pcHere, controllers,
  };
};

/**
 * @description 读取每 tick 的廉价不变量；每项为一次 Object.keys(...).length，不读取对象属性。
 * @returns 本方 spawn、建筑与 creep 的数量。
 */
export const readGameCounts = (): BootCounts => ({
  spawns: Object.keys(Game.spawns).length,
  structures: Object.keys(Game.structures).length,
  creeps: Object.keys(Game.creeps).length,
});
