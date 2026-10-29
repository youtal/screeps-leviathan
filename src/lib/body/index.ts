/**
 * 文件摘要：lib.body 的公共出口：身体常量、部件计数与体型展开、依据部件状态的能力与移动速度（设计见 docs/design/lib/body.md，架构设计 4.5、10.3）。
 *
 * 所属位置：src/lib/body/，lib 层的无状态纯函数，任何层都可以直接导入。
 * 拆分：constants.ts 为常量与 boost 倍率；counts.ts 只看部件类型（成本、孵化时间、展开、排列、用途分类）；
 * live.ts 计入伤损与 boost（经济能力、fatigue）。战斗能力与 tower 公式在 lib.combat。
 */
export {
  BODY_ORDER, BOOST_EFFECTS, BUILD_POWER, CARRY_CAPACITY, CREEP_CLAIM_LIFE_TIME, CREEP_LIFE_TIME, DISMANTLE_POWER,
  HARVEST_POWER, MAX_PARTS, PART_COST, REPAIR_POWER, SPAWN_TICKS_PER_PART, UPGRADE_POWER, boostFactor,
} from './constants';
export type { BoostMethod } from './constants';
export {
  arrange, bodyCost, classify, countParts, countsCost, emptyCounts, fit, lifeTime, partTotal, spawnTime,
} from './counts';
export type { BodyClass, BodyCounts, BodySpec } from './counts';
export { TERRAIN_FATIGUE, activeCounts, capabilities, fatigueWeight, partPower, stepTicks } from './live';
export type { Capabilities, PartState } from './live';
