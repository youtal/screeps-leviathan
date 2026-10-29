/**
 * 文件摘要：lib.combat 的单元测试。
 * 覆盖：常量与 @screeps/common 2.16.1 一致；tower 攻击、治疗、维修在距离 0–50 上与引擎公式逐项一致；
 * 300 个随机身体上 effectiveDamage 与引擎 _applyDamage 原文的结果一致，combatProfile 与引擎 calcBodyEffectiveness 一致
 * （fixtures/engine-constants.json，在场景测试镜像中采样）；12.3 的 tower 伤害公式。
 */
import {
  ATTACK_POWER, HEAL_POWER, RANGED_ATTACK_POWER, RANGED_HEAL_POWER, TOWER_ENERGY_COST, TOWER_FALLOFF, TOWER_FALLOFF_RANGE,
  TOWER_OPTIMAL_RANGE, TOWER_POWER_ATTACK, TOWER_POWER_HEAL, TOWER_POWER_REPAIR, combatProfile, effectiveDamage,
  towerAttack, towerHeal, towerRepair,
} from '@/lib/combat';
import { DISMANTLE_POWER } from '@/lib/body';
import type { PartState } from '@/lib/body';
import engine from './fixtures/engine-constants.json';

const C = engine.constants;
const bodies = engine.bodies as { body: PartState[]; damage: number; hitsLost: number; effect: Record<string, number> }[];

test('常量与引擎一致', () => {
  expect([ATTACK_POWER, RANGED_ATTACK_POWER, HEAL_POWER, RANGED_HEAL_POWER])
    .toEqual([C.ATTACK_POWER, C.RANGED_ATTACK_POWER, C.HEAL_POWER, C.RANGED_HEAL_POWER]);
  expect([TOWER_POWER_ATTACK, TOWER_POWER_HEAL, TOWER_POWER_REPAIR, TOWER_OPTIMAL_RANGE, TOWER_FALLOFF_RANGE, TOWER_FALLOFF, TOWER_ENERGY_COST])
    .toEqual([C.TOWER_POWER_ATTACK, C.TOWER_POWER_HEAL, C.TOWER_POWER_REPAIR, C.TOWER_OPTIMAL_RANGE, C.TOWER_FALLOFF_RANGE, C.TOWER_FALLOFF, C.TOWER_ENERGY_COST]);
});

test('tower 衰减与引擎逐距离一致', () => {
  for (const [range, attack, heal, repair] of engine.tower) {
    expect([range, towerAttack(range), towerHeal(range), towerRepair(range)]).toEqual([range, attack, heal, repair]);
  }
});

test('tower 伤害符合 12.3：≤ 5 为 600，≥ 20 为 150，其间 600 − (距离 − 5) × 30', () => {
  for (let r = 0; r <= 30; r += 1) {
    const expected = r <= 5 ? 600 : r >= 20 ? 150 : 600 - (r - 5) * 30;
    expect([r, towerAttack(r)]).toEqual([r, expected]);
  }
});

test('effectiveDamage 与引擎 _applyDamage 一致', () => {
  let reduced = 0;
  for (const sample of bodies) {
    expect([sample.damage, effectiveDamage(sample.body, sample.damage)]).toEqual([sample.damage, sample.hitsLost]);
    if (sample.hitsLost !== sample.damage) reduced += 1;
  }
  // 夹具中确有减伤的样本，避免比对只覆盖无 boost 的情形。
  expect(reduced).toBeGreaterThan(50);
});

test('effectiveDamage：XGHO2 的 TOUGH 吸收 100 / 0.3 的原始伤害', () => {
  const body: PartState[] = [{ type: 'tough', hits: 100, boost: 'XGHO2' }, { type: 'move', hits: 100 }];
  expect(effectiveDamage(body, 300)).toBe(90);
  // 吸收上限约 333.3：超出部分全额作用于后面的部件。
  expect(effectiveDamage(body, 400)).toBe(400 - Math.round((100 / 0.3) * 0.7));
  expect(effectiveDamage([{ type: 'tough', hits: 100 }], 300)).toBe(300);
});

test('combatProfile 与引擎 calcBodyEffectiveness 乘以动作基数一致', () => {
  for (const { body, effect } of bodies) {
    expect(combatProfile(body)).toEqual({
      attack: effect['attack.attack'] * ATTACK_POWER,
      rangedAttack: effect['ranged_attack.rangedAttack'] * RANGED_ATTACK_POWER,
      heal: effect['heal.heal'] * HEAL_POWER,
      rangedHeal: effect['heal.rangedHeal'] * RANGED_HEAL_POWER,
      dismantle: effect['work.dismantle'] * DISMANTLE_POWER,
    });
  }
});
