/**
 * 文件摘要：lib.combat，tower 的距离衰减、creep 的战斗能力与承受伤害的估算（设计见 docs/design/lib/combat.md，架构设计 7.5、10.7、12.3）。
 *
 * 所属位置：src/lib/combat/，lib 层的无状态纯函数，供 world.threat 估算敌方编组、defense 选择 tower 目标与防御者体型。
 * 引擎依据（engine 4.3.2）：
 *   - tower：processor/intents/towers/attack.js、heal.js、repair.js，距离超过 5 后线性衰减到 20 格处的 25%，结果向下取整；
 *     本模块不计 power creep 的 PWR_OPERATE_TOWER / PWR_DISRUPT_TOWER 效果，需要时由调用方乘以效果倍率；
 *   - 战斗能力：utils.js 的 calcBodyEffectiveness（只计有效部件，乘以 boost 倍率）乘以 *_POWER；
 *   - 承受伤害：processor/intents/creeps/tick.js 的 _applyDamage，从身体最前端起，boost 过的 TOUGH 按 damage 系数减伤。
 * 输入的部件状态与 lib.body 的 PartState 相同，游戏的 creep.body 可以直接传入。没有模块级可变状态。
 */
import { DISMANTLE_POWER, boostFactor } from '@/lib/body';
import type { PartState } from '@/lib/body';

/** 每个 ATTACK 每 tick 的近战伤害（`ATTACK_POWER`）。 */
export const ATTACK_POWER = 30;
/** 每个 RANGED_ATTACK 每 tick 的单体远程伤害（`RANGED_ATTACK_POWER`）。 */
export const RANGED_ATTACK_POWER = 10;
/** 每个 HEAL 每 tick 的相邻治疗量（`HEAL_POWER`）。 */
export const HEAL_POWER = 12;
/** 每个 HEAL 每 tick 的远程治疗量（`RANGED_HEAL_POWER`）。 */
export const RANGED_HEAL_POWER = 4;
/** tower 的基础攻击量（`TOWER_POWER_ATTACK`）。 */
export const TOWER_POWER_ATTACK = 600;
/** tower 的基础治疗量（`TOWER_POWER_HEAL`）。 */
export const TOWER_POWER_HEAL = 400;
/** tower 的基础维修量（`TOWER_POWER_REPAIR`）。 */
export const TOWER_POWER_REPAIR = 800;
/** tower 不衰减的最大距离（`TOWER_OPTIMAL_RANGE`）。 */
export const TOWER_OPTIMAL_RANGE = 5;
/** tower 衰减到最低的距离（`TOWER_FALLOFF_RANGE`）。 */
export const TOWER_FALLOFF_RANGE = 20;
/** tower 在最远处损失的比例（`TOWER_FALLOFF`）。 */
export const TOWER_FALLOFF = 0.75;
/** tower 每次动作的能量（`TOWER_ENERGY_COST`）。 */
export const TOWER_ENERGY_COST = 10;

/** 单个 creep 每 tick 的战斗能力，计入伤损与 boost。 */
export interface CombatProfile {
  /** 近战伤害。 */
  readonly attack: number;
  /** 单体远程伤害（rangedAttack，3 格内）。 */
  readonly rangedAttack: number;
  /** 相邻治疗量。 */
  readonly heal: number;
  /** 远程治疗量（3 格内）。 */
  readonly rangedHeal: number;
  /** 对建筑的拆除量（dismantle）。 */
  readonly dismantle: number;
}

/**
 * @description tower 动作随距离衰减后的数值，与引擎相同：距离 ≤ 5 为基础值，≥ 20 为 25%，其间线性插值后向下取整。
 * @param base 基础值，TOWER_POWER_ATTACK、TOWER_POWER_HEAL 或 TOWER_POWER_REPAIR。
 * @param range 与目标的 Chebyshev 距离。
 * @returns 本次动作的伤害、治疗或维修量。
 */
export const towerAmount = (base: number, range: number): number => {
  if (range <= TOWER_OPTIMAL_RANGE) return base;
  const r = range > TOWER_FALLOFF_RANGE ? TOWER_FALLOFF_RANGE : range;
  return Math.floor(base - (base * TOWER_FALLOFF * (r - TOWER_OPTIMAL_RANGE)) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE));
};

/**
 * @description tower 的攻击伤害（12.3：距离 ≤ 5 为 600，≥ 20 为 150）。
 * @param range 与目标的距离。
 * @returns 伤害。
 */
export const towerAttack = (range: number): number => towerAmount(TOWER_POWER_ATTACK, range);

/**
 * @description tower 的治疗量（距离 ≤ 5 为 400，≥ 20 为 100）。
 * @param range 与目标的距离。
 * @returns 治疗量。
 */
export const towerHeal = (range: number): number => towerAmount(TOWER_POWER_HEAL, range);

/**
 * @description tower 的维修量（距离 ≤ 5 为 800，≥ 20 为 200）。
 * @param range 与目标的距离。
 * @returns 维修 hits。
 */
export const towerRepair = (range: number): number => towerAmount(TOWER_POWER_REPAIR, range);

/**
 * @description 单个 creep 的战斗能力，一次遍历计算全部项目。编组的总伤害、总治疗由调用方按成员求和（架构 7.5）。
 * @param body 部件状态数组。
 * @returns 新的能力对象。
 */
export const combatProfile = (body: readonly PartState[]): CombatProfile => {
  let attack = 0;
  let rangedAttack = 0;
  let heal = 0;
  let rangedHeal = 0;
  let dismantle = 0;
  for (let i = 0; i < body.length; i += 1) {
    const { type, hits, boost } = body[i];
    if (hits <= 0) continue;
    if (type === 'attack') attack += boostFactor(type, boost, 'attack');
    else if (type === 'ranged_attack') rangedAttack += boostFactor(type, boost, 'rangedAttack');
    else if (type === 'heal') {
      heal += boostFactor(type, boost, 'heal');
      rangedHeal += boostFactor(type, boost, 'rangedHeal');
    } else if (type === 'work') dismantle += boostFactor(type, boost, 'dismantle');
  }
  return {
    attack: attack * ATTACK_POWER,
    rangedAttack: rangedAttack * RANGED_ATTACK_POWER,
    heal: heal * HEAL_POWER,
    rangedHeal: rangedHeal * RANGED_HEAL_POWER,
    dismantle: dismantle * DISMANTLE_POWER,
  };
};

/**
 * @description 一次伤害实际扣除的 hits，与引擎 _applyDamage 相同：从身体最前端的部件起依次承受伤害，
 * boost 过的部件按 damage 系数 k 减伤（该部件可吸收 hits / k 的原始伤害，其中 (1 − k) 部分被抵消），减伤总量四舍五入。
 * 只有 TOUGH 的化合物带 damage 系数；没有 boost 的身体不减伤。
 * @param body 部件状态数组，按身体顺序，hits 为当前值。
 * @param damage 本 tick 对该 creep 的原始伤害总和（引擎先累计同 tick 的全部伤害再结算）。
 * @returns 扣除的 hits；可能超过 creep 剩余的 hits（即被击杀）。
 */
export const effectiveDamage = (body: readonly PartState[], damage: number): number => {
  let reduce = 0;
  let rest = damage;
  for (let i = 0; i < body.length && rest > 0; i += 1) {
    const part = body[i];
    const ratio = boostFactor(part.type, part.boost, 'damage');
    const absorbed = Math.min(part.hits / ratio, rest);
    reduce += absorbed * (1 - ratio);
    rest -= absorbed;
  }
  return damage - Math.round(reduce);
};
