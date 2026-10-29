/**
 * 文件摘要：lib.body 的单元测试。
 * 覆盖：常量与 @screeps/common 2.16.1 一致；300 个随机身体（伤损、boost、携带量）上 partPower 与引擎 calcBodyEffectiveness、
 * fatigueWeight 与引擎 movement.js 的负重逐项一致（fixtures/engine-constants.json，在场景测试镜像中以引擎原文函数采样）；
 * 计数、成本、孵化时间与寿命；fit 的单元数约束；arrange 的顺序；classify 的判断顺序；stepTicks 的速度。
 */
import {
  BODY_ORDER, BOOST_EFFECTS, BUILD_POWER, CARRY_CAPACITY, CREEP_CLAIM_LIFE_TIME, CREEP_LIFE_TIME, DISMANTLE_POWER,
  HARVEST_POWER, MAX_PARTS, PART_COST, REPAIR_POWER, SPAWN_TICKS_PER_PART, TERRAIN_FATIGUE, UPGRADE_POWER,
  activeCounts, arrange, bodyCost, boostFactor, capabilities, classify, countParts, countsCost, emptyCounts, fatigueWeight,
  fit, lifeTime, partPower, partTotal, spawnTime, stepTicks,
} from '@/lib/body';
import type { BoostMethod, PartState } from '@/lib/body';
import engine from './fixtures/engine-constants.json';

const C = engine.constants;
const bodies = engine.bodies as { body: PartState[]; carried: number; effect: Record<string, number>; weight: number; nonMove: number }[];

test('常量与引擎一致', () => {
  expect(PART_COST).toEqual(C.BODYPART_COST);
  expect(BOOST_EFFECTS).toEqual(C.BOOSTS);
  expect([...BODY_ORDER].sort()).toEqual([...C.BODYPARTS_ALL].sort());
  expect([MAX_PARTS, SPAWN_TICKS_PER_PART, CREEP_LIFE_TIME, CREEP_CLAIM_LIFE_TIME, CARRY_CAPACITY])
    .toEqual([C.MAX_CREEP_SIZE, C.CREEP_SPAWN_TIME, C.CREEP_LIFE_TIME, C.CREEP_CLAIM_LIFE_TIME, C.CARRY_CAPACITY]);
  expect([HARVEST_POWER, BUILD_POWER, REPAIR_POWER, DISMANTLE_POWER, UPGRADE_POWER])
    .toEqual([C.HARVEST_POWER, C.BUILD_POWER, C.REPAIR_POWER, C.DISMANTLE_POWER, C.UPGRADE_CONTROLLER_POWER]);
});

test('partPower 与引擎 calcBodyEffectiveness 一致', () => {
  for (const sample of bodies) {
    for (const [key, expected] of Object.entries(sample.effect)) {
      const [type, method] = key.split('.') as [BodyPartConstant, BoostMethod];
      expect([key, partPower(sample.body, type, method)]).toEqual([key, expected]);
    }
  }
});

test('capabilities 等于各项 partPower 乘以动作基数', () => {
  for (const { body } of bodies) {
    expect(capabilities(body)).toEqual({
      harvest: partPower(body, 'work', 'harvest') * HARVEST_POWER,
      build: partPower(body, 'work', 'build') * BUILD_POWER,
      repair: partPower(body, 'work', 'repair') * REPAIR_POWER,
      dismantle: partPower(body, 'work', 'dismantle') * DISMANTLE_POWER,
      upgrade: partPower(body, 'work', 'upgradeController') * UPGRADE_POWER,
      capacity: partPower(body, 'carry', 'capacity') * CARRY_CAPACITY,
      move: partPower(body, 'move', 'fatigue'),
    });
  }
});

test('fatigueWeight 与引擎的负重一致（含失效部件与从末尾装载的 CARRY）', () => {
  for (const sample of bodies) expect(fatigueWeight(sample.body, sample.carried)).toBe(sample.nonMove + sample.weight);
});

test('boostFactor 对不适用的化合物与动作为 1', () => {
  expect(boostFactor('work', 'XUHO2', 'harvest')).toBe(7);
  expect(boostFactor('work', 'XUHO2', 'build')).toBe(1);
  expect(boostFactor('claim', 'XUHO2', 'harvest')).toBe(1);
  expect(boostFactor('work', undefined, 'harvest')).toBe(1);
});

test('计数、成本、孵化时间与寿命', () => {
  const parts: BodyPartConstant[] = ['work', 'work', 'carry', 'move', 'claim'];
  const counts = countParts(parts);
  expect(counts).toEqual({ ...emptyCounts(), work: 2, carry: 1, move: 1, claim: 1 });
  expect(Object.keys(counts)).toEqual([...BODY_ORDER]);
  expect(partTotal(counts)).toBe(5);
  expect(countsCost(counts)).toBe(bodyCost(parts));
  expect(bodyCost(parts)).toBe(200 + 50 + 50 + 600);
  expect(spawnTime(parts.length)).toBe(15);
  expect(lifeTime(counts)).toBe(600);
  expect(lifeTime({ work: 1 })).toBe(1500);
  const live: PartState[] = [{ type: 'work', hits: 0 }, { type: 'work', hits: 1 }, { type: 'move', hits: 100, boost: 'ZO' }];
  expect(activeCounts(live)).toEqual({ ...emptyCounts(), work: 1, move: 1 });
});

test('fit 在能量与部件上限内取最多单元', () => {
  const worker = { unit: { work: 1, carry: 1, move: 1 }, maxUnits: 5 };
  expect(fit(worker, 199)).toBeUndefined();
  expect(fit(worker, 200)).toEqual({ ...emptyCounts(), work: 1, carry: 1, move: 1 });
  expect(fit(worker, 550)).toEqual({ ...emptyCounts(), work: 2, carry: 2, move: 2 });
  expect(partTotal(fit(worker, 100000) ?? {})).toBe(15);
  // 部件上限：每单元 3 个部件，最多 16 个单元；加固定部分后受剩余部件数约束。
  expect(partTotal(fit({ unit: { carry: 2, move: 1 } }, 100000) ?? {})).toBe(48);
  expect(fit({ fixed: { move: 2 }, unit: { carry: 2, move: 1 } }, 100000)?.carry).toBe(32);
  // 固定部分放不下、minUnits 为 0 时只取固定部分。
  expect(fit({ fixed: { work: 5 }, unit: { move: 1 } }, 499)).toBeUndefined();
  expect(fit({ fixed: { work: 5 }, unit: { move: 1 }, minUnits: 0 }, 520)).toEqual({ ...emptyCounts(), work: 5 });
  expect(fit({ fixed: { work: 5 }, unit: {}, minUnits: 0 }, 600)).toEqual({ ...emptyCounts(), work: 5 });
});

test('arrange 按 TOUGH、CLAIM、CARRY、WORK、ATTACK、RANGED_ATTACK、HEAL、MOVE 排列', () => {
  expect(arrange({ move: 2, heal: 1, tough: 1, work: 1, carry: 1, attack: 1, ranged_attack: 1, claim: 1 }))
    .toEqual(['tough', 'claim', 'carry', 'work', 'attack', 'ranged_attack', 'heal', 'move', 'move']);
  expect(arrange({})).toEqual([]);
});

test('classify 的判断顺序', () => {
  const c = (parts: Partial<Record<BodyPartConstant, number>>) => classify({ ...emptyCounts(), ...parts });
  expect(c({ claim: 1, attack: 5, move: 1 })).toBe('claimer');
  expect(c({ heal: 2, attack: 1, ranged_attack: 1 })).toBe('healer');
  expect(c({ heal: 1, attack: 2 })).toBe('melee');
  expect(c({ attack: 1, ranged_attack: 2 })).toBe('ranged');
  expect(c({ attack: 2, ranged_attack: 2, work: 5 })).toBe('melee');
  expect(c({ work: 5, move: 1 })).toBe('miner');
  expect(c({ work: 5, carry: 1, move: 3 })).toBe('miner');
  expect(c({ work: 4, carry: 1, move: 2 })).toBe('worker');
  expect(c({ work: 1, carry: 1, move: 1 })).toBe('worker');
  expect(c({ carry: 4, move: 2 })).toBe('hauler');
  expect(c({ move: 1 })).toBe('scout');
  expect(c({ tough: 1 })).toBe('inert');
});

test('stepTicks：MOVE 与负重 1:1 在平原每 tick 一格，1:2 在道路每 tick 一格', () => {
  expect(TERRAIN_FATIGUE).toEqual({ road: 1, plain: 2, swamp: 10 });
  expect(stepTicks(2, 2, TERRAIN_FATIGUE.plain)).toBe(1);
  expect(stepTicks(4, 2, TERRAIN_FATIGUE.road)).toBe(1);
  expect(stepTicks(4, 2, TERRAIN_FATIGUE.plain)).toBe(2);
  expect(stepTicks(4, 2, TERRAIN_FATIGUE.swamp)).toBe(10);
  expect(stepTicks(0, 1, TERRAIN_FATIGUE.swamp)).toBe(1);
  expect(stepTicks(0, 0, TERRAIN_FATIGUE.plain)).toBe(Infinity);
});
