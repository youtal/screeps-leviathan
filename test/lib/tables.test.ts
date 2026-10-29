/**
 * 文件摘要：lib.tables 的单元测试。
 * 覆盖：各表与 @screeps/common 2.16.1 的常量逐项一致（fixtures/engine-constants.json，在场景测试镜像中采样，生成器见
 * fixtures/engine-constants.gen.cjs）；structureLimit 的取值规范化；unlockLevel 与 energyCapacityAt 的派生结果；表已冻结。
 */
import {
  DOWNGRADE_TICKS, EXTENSION_CAPACITY, MAX_RCL, RAMPART_MAX_HITS, SPAWN_CAPACITY, STRUCTURE_LIMITS, UPGRADE_PROGRESS,
  energyCapacityAt, structureLimit, unlockLevel,
} from '@/lib/tables';
import engine from './fixtures/engine-constants.json';

const C = engine.constants;
/** { [RCL 的字符串]: 值 } 形式的引擎表转换为 RCL 0–8 的数组，缺少的等级按 0。 */
const toArray = (table: Record<string, number>): number[] => Array.from({ length: MAX_RCL + 1 }, (_, r) => table[r] ?? 0);

test('建筑数量上限与引擎 CONTROLLER_STRUCTURES 一致', () => {
  const types = Object.keys(C.CONTROLLER_STRUCTURES) as BuildableStructureConstant[];
  expect(Object.keys(STRUCTURE_LIMITS).sort()).toEqual([...types].sort());
  for (const type of types) {
    expect([type, [...STRUCTURE_LIMITS[type]]]).toEqual([type, toArray(C.CONTROLLER_STRUCTURES[type] as Record<string, number>)]);
  }
});

test('extension 容量、rampart 上限、降级时长与升级进度与引擎一致', () => {
  expect(SPAWN_CAPACITY).toBe(C.SPAWN_ENERGY_CAPACITY);
  expect([...EXTENSION_CAPACITY]).toEqual(toArray(C.EXTENSION_ENERGY_CAPACITY));
  expect([...RAMPART_MAX_HITS]).toEqual(toArray(C.RAMPART_HITS_MAX));
  expect([...DOWNGRADE_TICKS]).toEqual(toArray(C.CONTROLLER_DOWNGRADE));
  expect([...UPGRADE_PROGRESS]).toEqual(toArray(C.CONTROLLER_LEVELS));
});

test('structureLimit 把等级规范到 0–8', () => {
  expect(structureLimit('extension', 3)).toBe(10);
  expect(structureLimit('extension', 3.9)).toBe(10);
  expect(structureLimit('extension', -1)).toBe(0);
  expect(structureLimit('extension', Number.NaN)).toBe(0);
  expect(structureLimit('extension', 12)).toBe(60);
});

test('unlockLevel 给出第 n 个建筑的最小等级', () => {
  expect(unlockLevel('spawn', 1)).toBe(1);
  expect(unlockLevel('spawn', 2)).toBe(7);
  expect(unlockLevel('extension', 5)).toBe(2);
  expect(unlockLevel('extension', 6)).toBe(3);
  expect(unlockLevel('container', 1)).toBe(0);
  expect(unlockLevel('tower', 7)).toBeUndefined();
  expect(unlockLevel('tower', 0)).toBeUndefined();
  expect(unlockLevel('tower', 1.5)).toBeUndefined();
  // 与逐级扫描的定义一致。
  for (const type of Object.keys(STRUCTURE_LIMITS) as BuildableStructureConstant[]) {
    for (let n = 1; n <= 61; n += 1) {
      const expected = STRUCTURE_LIMITS[type].findIndex((limit) => limit >= n);
      expect(unlockLevel(type, n)).toBe(expected < 0 ? undefined : expected);
    }
  }
});

test('energyCapacityAt 为满建 spawn 与 extension 的容量', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(energyCapacityAt)).toEqual([0, 300, 550, 800, 1300, 1800, 2300, 5600, 12900]);
});

test('表已冻结', () => {
  expect(Object.isFrozen(STRUCTURE_LIMITS) && Object.isFrozen(STRUCTURE_LIMITS.spawn) && Object.isFrozen(EXTENSION_CAPACITY)).toBe(true);
});
