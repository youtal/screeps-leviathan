/**
 * 文件摘要：lib.body 中依据实际部件状态（伤损与 boost）计算的能力与移动速度（设计见 docs/design/lib/body.md）。
 *
 * 所属位置：src/lib/body/，由 index.ts 导出。输入是 PartState 数组：游戏的 `creep.body`（BodyPartDefinition）可以直接传入，
 * 测试与快照也可以用普通对象。所有函数只读输入、不读取 Game。
 * 引擎依据（engine 4.3.2）：
 *   - 能力：utils.js 的 calcBodyEffectiveness，只计 hits > 0 的部件，乘以 boost 倍率；
 *   - fatigue：processor/intents/movement.js，每走一格增加 (非 MOVE 且非 CARRY 的部件数，含已失效的部件 + 装载中的 CARRY 数) × 地形系数，
 *     装载中的 CARRY 从身体末尾起按有效部件与 boost 后容量计数（calcResourcesWeight）；每 tick 由 MOVE 恢复 2 × 有效 MOVE 倍率之和
 *     （processor/intents/creeps/tick.js）。
 * 成本：每个函数遍历身体一次，capabilities 新建一个结果对象，其余不分配。没有模块级可变状态。
 */
import type { BodyCounts } from './counts';
import { emptyCounts } from './counts';
import {
  BUILD_POWER, CARRY_CAPACITY, DISMANTLE_POWER, HARVEST_POWER, REPAIR_POWER, UPGRADE_POWER, boostFactor,
} from './constants';
import type { BoostMethod } from './constants';

/** 单个部件的状态；结构上兼容游戏的 BodyPartDefinition。 */
export interface PartState {
  readonly type: BodyPartConstant;
  /** 剩余 hits，0–100；为 0 的部件不提供能力。 */
  readonly hits: number;
  /** 化合物；没有 boost 时缺省。 */
  readonly boost?: string | undefined;
}

/** 经济类能力，单位为每 tick。 */
export interface Capabilities {
  /** 采集 source 的能量。 */
  readonly harvest: number;
  /** 建造消耗的能量。 */
  readonly build: number;
  /** 维修的 hits。 */
  readonly repair: number;
  /** 拆除的 hits。 */
  readonly dismantle: number;
  /** 升级消耗的能量（RCL8 另受每 tick 15 的上限约束，由调用方处理）。 */
  readonly upgrade: number;
  /** 携带容量。 */
  readonly capacity: number;
  /** 有效 MOVE 的倍率之和；每 tick 恢复 2 倍此值的 fatigue。 */
  readonly move: number;
}

/** 地形系数（engine movement.js 的 fatigueRate）。{ [地形]: 每单位负重每走一格产生的 fatigue } */
export const TERRAIN_FATIGUE: Readonly<Record<'road' | 'plain' | 'swamp', number>> = Object.freeze({ road: 1, plain: 2, swamp: 10 });

/**
 * @description 某类有效部件在某个动作上的倍率之和，与引擎 calcBodyEffectiveness(body, type, method, 1, true) 相同；
 * 乘以动作基数（如 HARVEST_POWER）即得每 tick 的效果。
 * @param body 部件状态数组。
 * @param type 部件类型。
 * @param method 动作名，决定读取哪项 boost 倍率。
 * @returns 倍率之和；没有该类有效部件时为 0。
 */
export const partPower = (body: readonly PartState[], type: BodyPartConstant, method: BoostMethod): number => {
  let power = 0;
  for (let i = 0; i < body.length; i += 1) {
    const part = body[i];
    if (part.type === type && part.hits > 0) power += boostFactor(type, part.boost, method);
  }
  return power;
};

/**
 * @description 有效部件（hits > 0）的计数，不看 boost。用于用途分类与按部件数的判断。
 * @param body 部件状态数组。
 * @returns 新的计数对象。
 */
export const activeCounts = (body: readonly PartState[]): BodyCounts => {
  const counts = emptyCounts();
  for (let i = 0; i < body.length; i += 1) if (body[i].hits > 0) counts[body[i].type] += 1;
  return counts;
};

/**
 * @description 经济类能力，一次遍历同时计算全部项目，计入伤损与 boost。战斗能力见 lib.combat。
 * @param body 部件状态数组。
 * @returns 新的能力对象。
 */
export const capabilities = (body: readonly PartState[]): Capabilities => {
  let harvest = 0;
  let build = 0;
  let repair = 0;
  let dismantle = 0;
  let upgrade = 0;
  let capacity = 0;
  let move = 0;
  for (let i = 0; i < body.length; i += 1) {
    const { type, hits, boost } = body[i];
    if (hits <= 0) continue;
    if (type === 'work') {
      harvest += boostFactor(type, boost, 'harvest');
      build += boostFactor(type, boost, 'build');
      repair += boostFactor(type, boost, 'repair');
      dismantle += boostFactor(type, boost, 'dismantle');
      upgrade += boostFactor(type, boost, 'upgradeController');
    } else if (type === 'carry') capacity += boostFactor(type, boost, 'capacity');
    else if (type === 'move') move += boostFactor(type, boost, 'fatigue');
  }
  return {
    harvest: harvest * HARVEST_POWER,
    build: build * BUILD_POWER,
    repair: repair * REPAIR_POWER,
    dismantle: dismantle * DISMANTLE_POWER,
    upgrade: upgrade * UPGRADE_POWER,
    capacity: capacity * CARRY_CAPACITY,
    move,
  };
};

/**
 * @description 每走一格的负重：非 MOVE 且非 CARRY 的部件数（含已失效的部件），加上装载中的 CARRY 数。
 * 装载中的 CARRY 从身体末尾起，按有效部件与 boost 后容量依次装满计数，与引擎 calcResourcesWeight 一致。
 * @param body 部件状态数组。
 * @param carried 当前携带的资源总量。
 * @returns 负重；乘以地形系数即为走一格产生的 fatigue。
 */
export const fatigueWeight = (body: readonly PartState[], carried: number): number => {
  let weight = 0;
  for (let i = 0; i < body.length; i += 1) if (body[i].type !== 'move' && body[i].type !== 'carry') weight += 1;
  let rest = carried;
  for (let i = body.length - 1; i >= 0 && rest > 0; i -= 1) {
    const part = body[i];
    if (part.type !== 'carry' || part.hits <= 0) continue;
    rest -= Math.min(rest, CARRY_CAPACITY * boostFactor('carry', part.boost, 'capacity'));
    weight += 1;
  }
  return weight;
};

/**
 * @description 稳定行进时每走一格所需的 tick 数：fatigue 为 0 才能移动，走一格增加 负重 × 地形系数，每 tick 恢复 2 × MOVE 倍率之和。
 * @param weight fatigueWeight 的结果。
 * @param movePower 有效 MOVE 的倍率之和（capabilities 的 move，或 partPower(body, 'move', 'fatigue')）。
 * @param terrain 地形系数，见 TERRAIN_FATIGUE。
 * @returns 至少为 1 的 tick 数；没有有效 MOVE 时为 Infinity（引擎拒绝移动）。
 */
export const stepTicks = (weight: number, movePower: number, terrain: number): number => {
  if (movePower <= 0) return Infinity;
  return Math.max(1, Math.ceil((weight * terrain) / (2 * movePower)));
};
