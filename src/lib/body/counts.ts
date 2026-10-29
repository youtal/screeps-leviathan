/**
 * 文件摘要：lib.body 的部件计数、成本、孵化时间、体型展开、排列与用途分类（设计见 docs/design/lib/body.md，架构设计 10.3、11.6）。
 *
 * 所属位置：src/lib/body/，由 index.ts 导出。输入是部件类型数组或部件计数，不读取游戏对象，也不看 boost 与伤损。
 * 部件计数 BodyCounts 以部件类型为键、按 BODY_ORDER 的固定顺序创建字段，使所有计数对象共享同一个 V8 隐藏类；
 * 体型由 app.config 的 bodyFn 组合本文件的函数得到（fit 处理"固定部分 + 重复单元"的常见形态，其余规则由 bodyFn 直接算计数），
 * 再由 arrange 按 BODY_ORDER 排成 spawnCreep 所需的部件数组。没有模块级可变状态。
 */
import {
  BODY_ORDER, CREEP_CLAIM_LIFE_TIME, CREEP_LIFE_TIME, MAX_PARTS, PART_COST, SPAWN_TICKS_PER_PART,
} from './constants';

/** 各类部件的数量。{ [部件类型]: 数量 } */
export type BodyCounts = Record<BodyPartConstant, number>;

/** 用途分类的结果（架构 11.6 的 adopt 按身体组成推断用途）。 */
export type BodyClass = 'miner' | 'hauler' | 'worker' | 'melee' | 'ranged' | 'healer' | 'claimer' | 'scout' | 'inert';

/** 体型展开规格：固定部分加若干个重复单元。 */
export interface BodySpec {
  /** 固定部分，每个体型都包含一份；缺省为空。 */
  readonly fixed?: Readonly<Partial<BodyCounts>>;
  /** 重复单元。 */
  readonly unit: Readonly<Partial<BodyCounts>>;
  /** 最少单元数，缺省为 1；能量或部件数放不下时 fit 返回 undefined。 */
  readonly minUnits?: number;
  /** 最多单元数，缺省不限（只受 50 个部件与能量约束）。 */
  readonly maxUnits?: number;
}

/**
 * @description 新建全为 0 的部件计数，字段顺序固定为 BODY_ORDER。
 * @returns 新的计数对象，调用方可以原地修改。
 */
export const emptyCounts = (): BodyCounts => ({
  tough: 0, claim: 0, carry: 0, work: 0, attack: 0, ranged_attack: 0, heal: 0, move: 0,
});

/**
 * @description 统计部件类型数组中各类部件的数量。
 * @param parts 部件类型数组，例如 spawnCreep 的 body 参数。
 * @returns 新的计数对象。
 */
export const countParts = (parts: readonly BodyPartConstant[]): BodyCounts => {
  const counts = emptyCounts();
  for (let i = 0; i < parts.length; i += 1) counts[parts[i]] += 1;
  return counts;
};

/**
 * @description 部件总数。
 * @param counts 部件计数；缺少的字段按 0。
 * @returns 部件数。
 */
export const partTotal = (counts: Readonly<Partial<BodyCounts>>): number => {
  let n = 0;
  for (let i = 0; i < BODY_ORDER.length; i += 1) n += counts[BODY_ORDER[i]] ?? 0;
  return n;
};

/**
 * @description 部件计数对应的能量成本。
 * @param counts 部件计数；缺少的字段按 0。
 * @returns 能量。
 */
export const countsCost = (counts: Readonly<Partial<BodyCounts>>): number => {
  let cost = 0;
  for (let i = 0; i < BODY_ORDER.length; i += 1) cost += (counts[BODY_ORDER[i]] ?? 0) * PART_COST[BODY_ORDER[i]];
  return cost;
};

/**
 * @description 部件类型数组的能量成本。
 * @param parts 部件类型数组。
 * @returns 能量。
 */
export const bodyCost = (parts: readonly BodyPartConstant[]): number => {
  let cost = 0;
  for (let i = 0; i < parts.length; i += 1) cost += PART_COST[parts[i]];
  return cost;
};

/**
 * @description 孵化时间：每个部件 3 tick，不含 power creep 的 `PWR_OPERATE_SPAWN` 加速。
 * @param partCount 部件数。
 * @returns tick 数。
 */
export const spawnTime = (partCount: number): number => partCount * SPAWN_TICKS_PER_PART;

/**
 * @description creep 的寿命：含 CLAIM 部件时为 600，否则为 1500。用于提前孵化与续命的判断（架构 8.2）。
 * @param counts 部件计数。
 * @returns tick 数。
 */
export const lifeTime = (counts: Readonly<Partial<BodyCounts>>): number =>
  (counts.claim ?? 0) > 0 ? CREEP_CLAIM_LIFE_TIME : CREEP_LIFE_TIME;

/**
 * @description 按规格展开体型：在能量与 50 个部件的限制下取最多的重复单元。
 * 单元数 n = min(maxUnits, ⌊(能量 − 固定成本) / 单元成本⌋, ⌊(50 − 固定部件数) / 单元部件数⌋)；单元为空时 n 为 0。
 * @param spec 展开规格。
 * @param energy 可用于本次孵化的能量（平时为能量上限，紧急时为当前可用能量，由调用方决定）。
 * @returns 新的部件计数；n 小于 minUnits，或固定部分本身放不下时为 undefined。
 * @example
 * fit({ unit: { work: 1, carry: 1, move: 1 }, maxUnits: 5 }, 550); // 2 个单元：work 2、carry 2、move 2
 */
export const fit = (spec: BodySpec, energy: number): BodyCounts | undefined => {
  const fixed = spec.fixed ?? {};
  const fixedCost = countsCost(fixed);
  const fixedSize = partTotal(fixed);
  const unitCost = countsCost(spec.unit);
  const unitSize = partTotal(spec.unit);
  if (fixedCost > energy || fixedSize > MAX_PARTS) return undefined;
  let n = spec.maxUnits ?? MAX_PARTS;
  if (unitSize === 0) n = 0;
  else {
    n = Math.min(n, Math.floor((MAX_PARTS - fixedSize) / unitSize));
    // 单元成本为 0 只在单元为空时出现，这里 unitSize > 0，成本必为正。
    n = Math.min(n, Math.floor((energy - fixedCost) / unitCost));
  }
  if (n < (spec.minUnits ?? 1)) return undefined;
  const counts = emptyCounts();
  for (let i = 0; i < BODY_ORDER.length; i += 1) {
    const type = BODY_ORDER[i];
    counts[type] = (fixed[type] ?? 0) + (spec.unit[type] ?? 0) * n;
  }
  return counts;
};

/**
 * @description 按 BODY_ORDER（TOUGH、CLAIM、CARRY、WORK、ATTACK、RANGED_ATTACK、HEAL、MOVE）把计数排成部件数组。
 * @param counts 部件计数；缺少的字段按 0。
 * @returns 新的部件类型数组，可直接传给 spawnCreep。
 */
export const arrange = (counts: Readonly<Partial<BodyCounts>>): BodyPartConstant[] => {
  const parts: BodyPartConstant[] = [];
  for (let i = 0; i < BODY_ORDER.length; i += 1) {
    const type = BODY_ORDER[i];
    for (let k = counts[type] ?? 0; k > 0; k -= 1) parts.push(type);
  }
  return parts;
};

/**
 * @description 按身体组成推断用途，供接手与自我认领（架构 11.6）。只看部件计数，结合位置的判断（例如"source 旁 WORK 多"）由领域完成。
 * 判断顺序：CLAIM → 战斗部件（治疗不少于攻击与远程之和为治疗，否则攻击不少于远程为近战，否则远程）→
 * WORK（没有 CARRY，或 WORK ≥ 5 且 CARRY ≤ 1 为矿工，与 app.config 的矿工体型一致；否则为工人）→ CARRY（搬运工）→
 * 只剩 MOVE 为侦察；没有任何部件为无效。
 * @param counts 部件计数；判断接手资产时应传有效部件（activeCounts），已失效的部件不提供能力。
 * @returns 用途分类。
 */
export const classify = (counts: Readonly<BodyCounts>): BodyClass => {
  if (counts.claim > 0) return 'claimer';
  const fight = counts.attack + counts.ranged_attack;
  if (counts.heal > 0 || fight > 0) {
    if (counts.heal >= fight) return 'healer';
    return counts.attack >= counts.ranged_attack ? 'melee' : 'ranged';
  }
  if (counts.work > 0) return counts.carry === 0 || (counts.work >= 5 && counts.carry <= 1) ? 'miner' : 'worker';
  if (counts.carry > 0) return 'hauler';
  if (counts.move > 0) return 'scout';
  return 'inert';
};
