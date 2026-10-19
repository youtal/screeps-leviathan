/**
 * 文件摘要：保底循环（src/fallback.ts）的单元测试，以 test/fallback/world.ts 的游戏世界替身驱动。
 * 替身与平台语义一致：FIND_MY_CREEPS 不含孵化中的 creep、寻路调用 roomCallback、spawnCreep 会访问 Memory.creeps。
 * 覆盖防御与治疗、应急孵化与接替者判断、固定与无 CARRY 矿工、工人与搬运者分工、防降级、当 tick 预留、
 * CPU 上限与快照复用、寻路上限与成本矩阵、房间与资产级异常隔离、Memory 接管前置条件，以及有效代码不超过 400 行。
 * 编号 KS-xx 对应 docs/audit/2026-10-19-kernel-skeleton.md 的整改项。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runFallback } from '@/fallback';
import { type FakeMatrix, creep, installWorld, pos, store, structure } from './world';

const W = ['work', 'carry', 'move'];
const C = ['carry', 'move'];

beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

/**
 * @description 创建带 300 能量的 spawn，并让它记录 spawnCreep 的全部参数。
 * @param x 横坐标，默认 20。
 * @param extra 额外字段，例如 spawning。
 * @returns spawn 替身与参数记录。
 */
const recordingSpawn = (x = 20, extra: Record<string, unknown> = {}) => {
  const spawn = structure('spawn', pos(x, 20), { store: store(300, 300), ...extra });
  const calls: unknown[][] = [];
  const original = spawn.spawnCreep as (...args: unknown[]) => number;
  spawn.spawnCreep = (...args: unknown[]) => { calls.push(args); return original(...args); };
  return { spawn, calls };
};

describe('防御', () => {
  test('tower 攻击最近的敌人', () => {
    const tower = structure('tower', pos(10, 10), { store: store(500, 1000) });
    const near = creep({ name: 'near', at: pos(12, 10), body: ['attack'] });
    const far = creep({ name: 'far', at: pos(30, 10), body: ['attack'] });
    const w = installWorld({ rooms: [{ structures: [tower], hostiles: [far, near] }] });
    runFallback();
    expect(w.actions).toContainEqual([tower.id, 'attack', near.id]);
  });

  test('没有敌人时治疗受伤的己方 creep；能量不足一半时不治疗', () => {
    const hurt = creep({ name: 'hurt', at: pos(11, 10), body: ['move'], hits: 40 });
    const full = structure('tower', pos(10, 10), { store: store(600, 1000) });
    const w = installWorld({ rooms: [{ structures: [full], creeps: [hurt] }] });
    runFallback();
    expect(w.actions).toContainEqual([full.id, 'heal', hurt.id]);
    const low = structure('tower', pos(10, 10), { store: store(400, 1000) });
    const w2 = installWorld({ rooms: [{ structures: [low], creeps: [hurt] }] });
    runFallback();
    expect(w2.actions.filter(([, a]) => a === 'heal')).toEqual([]);
  });
});

describe('应急孵化', () => {
  test('没有可用采集者时孵化 [WORK, CARRY, MOVE]，名称为 fb-<shard>-<tick base36>-<序号>', () => {
    const { spawn, calls } = recordingSpawn();
    installWorld({ rooms: [{ structures: [spawn], creeps: [creep({ name: 'hauler', at: pos(5, 5), body: C })] }], time: 1000, memory: {} });
    runFallback();
    expect(calls).toEqual([[['work', 'carry', 'move'], `fb-shard0-${(1000).toString(36)}-0`]]);
  });

  test('名称已被占用时序号递增', () => {
    const { spawn, calls } = recordingSpawn();
    const taken = creep({ name: `fb-shard0-${(1000).toString(36)}-0`, at: pos(1, 1, 'W9N9'), body: C });
    installWorld({ rooms: [{ structures: [spawn] }, { name: 'W9N9', creeps: [taken] }], time: 1000, memory: {} });
    runFallback();
    expect(calls[0][1]).toBe(`fb-shard0-${(1000).toString(36)}-1`);
  });

  test.each([
    ['已有可移动的采集者', { creeps: [creep({ name: 'w', at: pos(5, 5), body: W })] }],
    ['已有紧挨 source 的固定采集者', { creeps: [creep({ name: 's', at: pos(5, 5), body: ['work', 'carry'] })], sources: [structure('source', pos(5, 6))] }],
    ['已有无 CARRY 的可移动矿工（KS-02，它确实会采集）', { creeps: [creep({ name: 'm', at: pos(5, 5), body: ['work', 'work', 'move'] })], sources: [structure('source', pos(30, 30))] }],
    ['能量不足 200', { energyAvailable: 150 }],
  ])('%s时不孵化', (_label, room) => {
    const { spawn, calls } = recordingSpawn();
    installWorld({ rooms: [{ structures: [spawn], ...room }], memory: {} });
    runFallback();
    expect(calls).toEqual([]);
  });

  test('KS-03：另一 spawn 正在孵化带 WORK 的接替者时不再孵化（FIND_MY_CREEPS 不含孵化中的 creep）', () => {
    const pending = creep({ name: 'fb-shard0-r0-0', at: pos(10, 20), body: W, spawning: true });
    const busy = structure('spawn', pos(10, 20), { store: store(300, 300), spawning: { name: pending.name } });
    const { spawn, calls } = recordingSpawn(30);
    installWorld({ rooms: [{ structures: [busy, spawn], creeps: [pending] }], memory: {} });
    runFallback();
    expect(calls).toEqual([]);
  });

  test('KS-03：正在孵化的 creep 没有 WORK 时不算接替者，照常孵化', () => {
    const pending = creep({ name: 'carrier', at: pos(10, 20), body: C, spawning: true });
    const busy = structure('spawn', pos(10, 20), { store: store(300, 300), spawning: { name: pending.name } });
    const { spawn, calls } = recordingSpawn(30);
    installWorld({ rooms: [{ structures: [busy, spawn], creeps: [pending] }], memory: {} });
    runFallback();
    expect(calls).toHaveLength(1);
  });
});

describe('creep 工作', () => {
  test('固定 creep 只做原地动作：采集相邻 source，不移动', () => {
    const source = structure('source', pos(5, 6));
    const miner = creep({ name: 'miner', at: pos(5, 5), body: ['work', 'work', 'carry'] });
    const w = installWorld({ rooms: [{ creeps: [miner], sources: [source] }] });
    runFallback();
    expect(w.actions).toEqual([['miner', 'harvest', source.id]]);
  });

  test('KS-02：无 CARRY 的固定矿工照常采集（能量按引擎规则落地）', () => {
    const source = structure('source', pos(5, 6));
    const miner = creep({ name: 'miner', at: pos(5, 5), body: ['work', 'work'], capacity: 0 });
    const w = installWorld({ rooms: [{ creeps: [miner], sources: [source] }] });
    runFallback();
    expect(w.actions).toEqual([['miner', 'harvest', source.id]]);
  });

  test('KS-02：无 CARRY 的可移动矿工远离 source 时前往，紧挨时采集', () => {
    const source = structure('source', pos(30, 30));
    const far = creep({ name: 'far', at: pos(5, 5), body: ['work', 'move'], capacity: 0 });
    const near = creep({ name: 'near', at: pos(30, 31), body: ['work', 'move'], capacity: 0 });
    const w = installWorld({ rooms: [{ creeps: [far, near], sources: [source] }] });
    runFallback();
    expect(w.actions).toEqual([['far', 'move', 1], ['near', 'harvest', source.id]]);
  });

  test('携能搬运者按 spawn → extension 的顺序补能，相邻时直接转移', () => {
    const spawn = structure('spawn', pos(10, 10), { store: store(300, 300) });
    const ext = structure('extension', pos(10, 12), { store: store(0, 50) });
    const hauler = creep({ name: 'h', at: pos(10, 11), body: C, energy: 50 });
    const w = installWorld({ rooms: [{ structures: [spawn, ext], creeps: [hauler, creep({ name: 'w', at: pos(1, 1), body: W })] }] });
    runFallback();
    expect(w.actions).toContainEqual(['h', 'transfer', ext.id]);
  });

  test('当 tick 预留：两个搬运者不争抢同一小额掉落能量', () => {
    const small = structure('energy', pos(10, 10), { amount: 30, resourceType: 'energy' });
    const big = structure('energy', pos(20, 10), { amount: 500, resourceType: 'energy' });
    const a = creep({ name: 'a', at: pos(10, 11), body: C });
    const b = creep({ name: 'b', at: pos(11, 11), body: C });
    const w = installWorld({ rooms: [{ creeps: [a, b, creep({ name: 'w', at: pos(1, 1), body: W })], dropped: [small, big] }] });
    runFallback();
    expect(w.actions).toContainEqual(['a', 'pickup', small.id]);
    expect(w.actions.filter(([actor]) => actor === 'b')).toEqual([['b', 'move', 1]]);
  });

  test('KS-04：固定 creep 也使用当 tick 预留，不与移动搬运者争抢同一小额能量', () => {
    const small = structure('energy', pos(10, 10), { amount: 30, resourceType: 'energy' });
    const fixed = creep({ name: 'fixed', at: pos(10, 11), body: ['carry'] });
    const mobile = creep({ name: 'mobile', at: pos(11, 11), body: C });
    const w = installWorld({ rooms: [{ creeps: [fixed, mobile, creep({ name: 'w', at: pos(1, 1), body: W })], dropped: [small] }] });
    runFallback();
    expect(w.actions.filter(([, a, t]) => a === 'pickup' && t === small.id)).toEqual([['fixed', 'pickup', small.id]]);
  });

  test('防降级应急：带能工人优先升级，其余工人照常补能', () => {
    const spawn = structure('spawn', pos(24, 22), { store: store(100, 300) });
    const first = creep({ name: 'first', at: pos(24, 24), body: W, energy: 50 });
    const second = creep({ name: 'second', at: pos(24, 23), body: W, energy: 50 });
    const w = installWorld({ rooms: [{ level: 3, ticksToDowngrade: 1000, structures: [spawn], creeps: [first, second] }] });
    runFallback();
    expect(w.actions).toContainEqual(['first', 'upgradeController', 'controller-W1N1']);
    expect(w.actions).toContainEqual(['second', 'transfer', spawn.id]);
  });

  test('KS-01：空载工人排在前面时，名额仍给带能且在范围内的工人，并最先处理', () => {
    const spawn = structure('spawn', pos(24, 22), { store: store(100, 300) });
    const empty = creep({ name: 'empty', at: pos(5, 5), body: W });
    const loaded = creep({ name: 'loaded', at: pos(24, 23), body: W, energy: 50 });
    const w = installWorld({ rooms: [{ level: 3, ticksToDowngrade: 1, structures: [spawn], creeps: [empty, loaded], sources: [structure('source', pos(40, 40))] }] });
    runFallback();
    expect(w.actions[0]).toEqual(['loaded', 'upgradeController', 'controller-W1N1']);
  });

  test('KS-01：固定工人带能且在升级范围内时，应急优先升级而不是补能', () => {
    const spawn = structure('spawn', pos(24, 23), { store: store(100, 300) });
    const fixed = creep({ name: 'fixed', at: pos(24, 24), body: ['work', 'carry'], energy: 50 });
    const w = installWorld({ rooms: [{ level: 3, ticksToDowngrade: 1, structures: [spawn], creeps: [fixed] }] });
    runFallback();
    expect(w.actions).toEqual([['fixed', 'upgradeController', 'controller-W1N1']]);
  });

  test('刚提交的取能不当作已拿到能量：应急升级者空载时只取能，不在同 tick 升级', () => {
    const container = structure('container', pos(24, 22), { store: store(500, 2000) });
    const worker = creep({ name: 'w', at: pos(24, 23), body: W });
    const w = installWorld({ rooms: [{ level: 3, ticksToDowngrade: 1, structures: [container], creeps: [worker] }] });
    runFallback();
    expect(w.actions).toEqual([['w', 'withdraw', container.id]]);
  });

  test('空载工人在没有可取能量时前往 source 采集', () => {
    const source = structure('source', pos(30, 30));
    const worker = creep({ name: 'w', at: pos(10, 10), body: W });
    const w = installWorld({ rooms: [{ creeps: [worker], sources: [source] }] });
    runFallback();
    expect(w.actions).toEqual([['w', 'move', 1]]);
  });
});

describe('运行约束', () => {
  test('KS-05：CPU 一开始就到达上限时不查询房间、不提交动作', () => {
    const tower = structure('tower', pos(10, 10), { store: store(500, 1000) });
    const w = installWorld({ rooms: [{ structures: [tower], hostiles: [creep({ name: 'x', at: pos(11, 10), body: ['attack'] })] }], cpu: [600] });
    runFallback();
    expect(w.actions).toEqual([]);
    expect(w.finds).toBe(0);
  });

  test('KS-05：每类对象每房每 tick 只查询一次，与 creep 数量无关', () => {
    const source = structure('source', pos(40, 40));
    // 携能工人与空载工人都覆盖：补能、取能、采集三条路径在每个 creep 上各走一遍，查询次数仍不随 creep 数增长。
    const run = (count: number) => {
      const workers = Array.from({ length: count }, (_, i) => creep({ name: `w${i}`, at: pos(i % 10, 1), body: W, energy: i % 2 === 0 ? 50 : 0 }));
      const spawn = structure('spawn', pos(20, 20), { store: store(0, 3000) });
      const w = installWorld({ rooms: [{ creeps: workers, sources: [source], structures: [spawn] }] });
      runFallback();
      return w.finds;
    };
    expect(run(1)).toBe(run(15));
    expect(run(1)).toBeLessThanOrEqual(12);
  });

  test('每 tick 寻路次数不超过上限', () => {
    const source = structure('source', pos(40, 40));
    const workers = Array.from({ length: 30 }, (_, i) => creep({ name: `w${i}`, at: pos(i % 10, Math.floor(i / 10)), body: W }));
    const w = installWorld({ rooms: [{ creeps: workers, sources: [source] }] });
    runFallback();
    expect(w.paths).toBe(20);
  });

  test('KS-07：成本矩阵把 source、mineral、controller 与己方阻挡类工地记为 255，道路为 1，可通过建筑与非阻挡工地为 0', () => {
    const source = structure('source', pos(30, 30));
    const mineral = structure('mineral', pos(35, 35));
    const road = structure('road', pos(12, 10));
    const container = structure('container', pos(13, 10), { store: store(0, 2000) });
    const towerSite = structure('site', pos(14, 10), { structureType: 'tower' });
    const roadSite = structure('site', pos(15, 10), { structureType: 'road' });
    const worker = creep({ name: 'w', at: pos(10, 10), body: W });
    const w = installWorld({ rooms: [{ creeps: [worker], sources: [source], minerals: [mineral], structures: [road, container], sites: [towerSite, roadSite] }] });
    runFallback();
    const matrix = w.matrices[0] as FakeMatrix;
    expect([matrix.get(30, 30), matrix.get(35, 35), matrix.get(25, 25), matrix.get(14, 10)]).toEqual([255, 255, 255, 255]);
    expect([matrix.get(12, 10), matrix.get(13, 10), matrix.get(15, 10)]).toEqual([1, 0, 0]);
    expect(w.searches[0]).toMatchObject({ maxRooms: 1, maxOps: 1000 });
  });

  test('KS-06：一个房间查询抛错不影响其他房间', () => {
    const source = structure('source', pos(8, 6, 'W2N2'));
    const miner = creep({ name: 'miner', at: pos(8, 5, 'W2N2'), body: ['work', 'carry'] });
    const w = installWorld({ rooms: [{ broken: true }, { name: 'W2N2', creeps: [miner], sources: [source] }] });
    runFallback();
    expect(w.actions).toContainEqual(['miner', 'harvest', source.id]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('房间 W1N1 查询失败'));
  });

  test('KS-06：单个 tower 抛错不影响其他 tower；单个 creep 抛错不影响其他 creep', () => {
    const enemy = creep({ name: 'x', at: pos(11, 10), body: ['attack'] });
    const brokenTower = structure('tower', pos(9, 10), { store: { getUsedCapacity: () => { throw new Error('坏掉的 tower'); } } });
    const tower = structure('tower', pos(10, 10), { store: store(500, 1000) });
    const brokenCreep = creep({ name: 'broken', at: pos(5, 5), body: W });
    brokenCreep.getActiveBodyparts = () => { throw new Error('坏掉的 creep'); };
    const source = structure('source', pos(8, 6));
    const miner = creep({ name: 'miner', at: pos(8, 5), body: ['work', 'carry'] });
    const w = installWorld({ rooms: [{ structures: [brokenTower, tower], hostiles: [enemy], creeps: [brokenCreep, miner], sources: [source] }] });
    runFallback();
    expect(w.actions).toContainEqual([tower.id, 'attack', enemy.id]);
    expect(w.actions).toContainEqual(['miner', 'harvest', source.id]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('坏掉的 tower'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('坏掉的 creep'));
  });

  test('保底代码自身不访问 Memory 或 RawMemory：防御、物流与防降级一整轮在守卫下运行', () => {
    const spawn = structure('spawn', pos(20, 20), { store: store(100, 300) });
    const tower = structure('tower', pos(10, 10), { store: store(600, 1000) });
    const hauler = creep({ name: 'h', at: pos(19, 20), body: C, energy: 50, hits: 50 });
    const worker = creep({ name: 'w', at: pos(24, 24), body: W, energy: 50 });
    const w = installWorld({ rooms: [{ level: 2, ticksToDowngrade: 100, structures: [spawn, tower], creeps: [hauler, worker] }] });
    runFallback();
    expect(w.storageTouched).toBe(false);
    expect(w.actions.length).toBeGreaterThan(2);
  });

  test('KS-08：引擎的 spawnCreep 会访问 Memory.creeps；入口已接管时写入落在临时对象上，未接管时孵化失败并被隔离', () => {
    const temp: Record<string, unknown> = {};
    const { spawn, calls } = recordingSpawn();
    installWorld({ rooms: [{ structures: [spawn] }], time: 1000, memory: temp });
    runFallback();
    expect(calls).toHaveLength(1);
    expect(Object.keys(temp.creeps as object)).toEqual([`fb-shard0-${(1000).toString(36)}-0`]);
    const guarded = recordingSpawn();
    const w = installWorld({ rooms: [{ structures: [guarded.spawn] }] });
    runFallback();
    expect(w.storageTouched).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('访问了 Memory'));
  });

  test('有效代码（不计空行与纯注释行）不超过 400 行', () => {
    const lines = readFileSync(resolve(__dirname, '../../src/fallback.ts'), 'utf8').split('\n')
      .filter((line) => line.trim() !== '' && !/^\s*(\/\/|\/\*\*?|\*\/?)/.test(line));
    expect(lines.length).toBeLessThanOrEqual(400);
  });
});
