/**
 * 文件摘要：lib.body 的常量：部件成本、部件排列顺序、boost 倍率与各动作的基数（设计见 docs/design/lib/body.md）。
 *
 * 所属位置：src/lib/body/，供本模块的计数、展开与能力计算使用，也由 index.ts 导出给 lib.combat 与上层。
 * 数据来源：数值抄自 @screeps/common 2.16.1 的 constants.js（BODYPART_COST、BOOSTS 与各 *_POWER），单元测试逐项比对
 * 场景镜像中采样的 test/lib/fixtures/engine-constants.json。不读取游戏全局常量，调用方与测试不需要全局替身。
 * 没有模块级可变状态：所有表都已冻结。
 */

/** 单个 creep 的部件数上限（`MAX_CREEP_SIZE`）。 */
export const MAX_PARTS = 50;
/** 每个部件的孵化时间（`CREEP_SPAWN_TIME`）。 */
export const SPAWN_TICKS_PER_PART = 3;
/** 普通 creep 的寿命（`CREEP_LIFE_TIME`）。 */
export const CREEP_LIFE_TIME = 1500;
/** 含 CLAIM 部件的 creep 的寿命（`CREEP_CLAIM_LIFE_TIME`）。 */
export const CREEP_CLAIM_LIFE_TIME = 600;
/** 每个 CARRY 部件的容量（`CARRY_CAPACITY`）。 */
export const CARRY_CAPACITY = 50;
/** 每个 WORK 每 tick 采集 source 的能量（`HARVEST_POWER`）。 */
export const HARVEST_POWER = 2;
/** 每个 WORK 每 tick 建造消耗的能量（`BUILD_POWER`）。 */
export const BUILD_POWER = 5;
/** 每个 WORK 每 tick 维修的 hits（`REPAIR_POWER`）。 */
export const REPAIR_POWER = 100;
/** 每个 WORK 每 tick 拆除的 hits（`DISMANTLE_POWER`）。 */
export const DISMANTLE_POWER = 50;
/** 每个 WORK 每 tick 升级消耗的能量（`UPGRADE_CONTROLLER_POWER`）。 */
export const UPGRADE_POWER = 1;

/** 部件的能量成本（`BODYPART_COST`）。{ [部件类型]: 能量 } */
export const PART_COST: Readonly<Record<BodyPartConstant, number>> = Object.freeze({
  move: 50, work: 100, attack: 80, carry: 50, heal: 250, ranged_attack: 150, tough: 10, claim: 600,
});

/**
 * 孵化时的部件排列顺序。伤害从身体最前端的部件开始扣除（engine processor/intents/creeps/tick.js），
 * 所以 TOUGH 在最前承受伤害，MOVE 在最后，使 creep 受伤后仍能移动；CLAIM 与 CARRY 价值低、靠前，
 * 攻击、远程与治疗靠后，尽量晚失效。
 */
export const BODY_ORDER: readonly BodyPartConstant[] = Object.freeze([
  'tough', 'claim', 'carry', 'work', 'attack', 'ranged_attack', 'heal', 'move',
] as const);

/** boost 影响的动作名，与引擎 BOOSTS 表中的键一致。 */
export type BoostMethod =
  | 'harvest' | 'build' | 'repair' | 'dismantle' | 'upgradeController'
  | 'attack' | 'rangedAttack' | 'rangedMassAttack' | 'heal' | 'rangedHeal'
  | 'capacity' | 'fatigue' | 'damage';

/** 一种化合物对各动作的倍率。{ [动作名]: 倍率 } */
type BoostEffect = Readonly<Partial<Record<BoostMethod, number>>>;

/**
 * boost 倍率（`BOOSTS`）。{ [部件类型]: { [化合物]: { [动作名]: 倍率 } } }
 * damage 是承受伤害的系数（小于 1 表示减伤），其余为能力倍数；claim 部件没有 boost。
 */
export const BOOST_EFFECTS: Readonly<Partial<Record<BodyPartConstant, Readonly<Record<string, BoostEffect>>>>> = Object.freeze({
  work: Object.freeze({
    UO: { harvest: 3 }, UHO2: { harvest: 5 }, XUHO2: { harvest: 7 },
    LH: { build: 1.5, repair: 1.5 }, LH2O: { build: 1.8, repair: 1.8 }, XLH2O: { build: 2, repair: 2 },
    ZH: { dismantle: 2 }, ZH2O: { dismantle: 3 }, XZH2O: { dismantle: 4 },
    GH: { upgradeController: 1.5 }, GH2O: { upgradeController: 1.8 }, XGH2O: { upgradeController: 2 },
  }),
  attack: Object.freeze({ UH: { attack: 2 }, UH2O: { attack: 3 }, XUH2O: { attack: 4 } }),
  ranged_attack: Object.freeze({
    KO: { rangedAttack: 2, rangedMassAttack: 2 }, KHO2: { rangedAttack: 3, rangedMassAttack: 3 },
    XKHO2: { rangedAttack: 4, rangedMassAttack: 4 },
  }),
  heal: Object.freeze({ LO: { heal: 2, rangedHeal: 2 }, LHO2: { heal: 3, rangedHeal: 3 }, XLHO2: { heal: 4, rangedHeal: 4 } }),
  carry: Object.freeze({ KH: { capacity: 2 }, KH2O: { capacity: 3 }, XKH2O: { capacity: 4 } }),
  move: Object.freeze({ ZO: { fatigue: 2 }, ZHO2: { fatigue: 3 }, XZHO2: { fatigue: 4 } }),
  tough: Object.freeze({ GO: { damage: 0.7 }, GHO2: { damage: 0.5 }, XGHO2: { damage: 0.3 } }),
});

/**
 * @description 查询部件在某个动作上的 boost 倍率，规则与引擎 utils.js 的 calcBodyEffectiveness 一致：
 * 没有 boost、化合物不适用于该部件或该动作时为 1。
 * @param type 部件类型。
 * @param boost 化合物；undefined 表示没有 boost。
 * @param method 动作名。
 * @returns 倍率。
 */
export const boostFactor = (type: BodyPartConstant, boost: string | undefined, method: BoostMethod): number => {
  if (boost === undefined) return 1;
  return BOOST_EFFECTS[type]?.[boost]?.[method] ?? 1;
};
