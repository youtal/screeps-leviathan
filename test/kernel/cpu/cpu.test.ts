/**
 * 文件摘要：kernel.cpu 的单元测试，以假 CPU 端口与普通对象节点驱动，不经 lifecycle。
 * 覆盖：预算 B、透支额与收尾预留；预算视图按层计算；生存层总是准入；预计耗用预检；四层的层条件；
 * 先判定所属模块与依赖、防止永久落选（审计 LC-02）；依赖空闲不阻挡、落选则阻挡；
 * 因预算落选时衰减预计值、因依赖落选时不衰减（审计 LC-03）；平滑耗用与摘要；准入时清零 spent；
 * 维护层相位在构造时确定、准入不逐 tick 计算哈希（ultrareview 第 8 项，以调用次数确认）。
 */
import type { Tier } from '@/contracts/cpu';
import {
  CPU_EMA_ALPHA, type CpuNode, MAINTENANCE_PERIOD, maintenancePhase, VERDICT_ADMIT, VERDICT_IDLE, VERDICT_NONE, VERDICT_REJECT, createCpu,
} from '@/kernel/cpu';
import { hashString } from '@/lib/hash';

// hashString 的调用计数（ultrareview 第 8 项的验证依据）；包装后的函数行为与原函数相同。
// jest.mock 的工厂会被提升到文件顶部，只能引用以 mock 开头的变量。
const mockHashCalls = { n: 0 };
jest.mock('@/lib/hash', () => {
  const actual = jest.requireActual<typeof import('@/lib/hash')>('@/lib/hash');
  return { ...actual, hashString: (text: string) => { mockHashCalls.n += 1; return actual.hashString(text); } };
});

/** 可调的 CPU 端口。 */
const port = { time: 100, used: 0, limit: 20, tickLimit: 500, bucket: 5000 };
const fake = {
  /**
   * @description 当前 tick。
   * @returns port.time。
   */
  time: () => port.time,
  /**
   * @description 已用 CPU。
   * @returns port.used。
   */
  cpuUsed: () => port.used,
  /**
   * @description 每 tick 额度。
   * @returns port.limit。
   */
  limit: () => port.limit,
  /**
   * @description tick 上限。
   * @returns port.tickLimit。
   */
  tickLimit: () => port.tickLimit,
  /**
   * @description bucket。
   * @returns port.bucket。
   */
  bucket: () => port.bucket,
};

beforeEach(() => Object.assign(port, { time: 100, used: 0, limit: 20, tickLimit: 500, bucket: 5000 }));

/**
 * @description 创建一个进程节点。
 * @param key 进程键。
 * @param tier 层级。
 * @param cost 已有样本的平滑耗用；undefined 表示没有样本。
 * @param extra 所属模块或依赖。
 * @param extra.owner 所属模块。
 * @param extra.deps requires 依赖。
 * @returns 节点。
 */
const node = (key: string, tier: Tier, cost?: number, extra: { owner?: CpuNode; deps?: CpuNode[] } = {}): CpuNode => ({
  key, phase: maintenancePhase(key), tier, owner: extra.owner, deps: extra.deps ?? [], runnable: true, cost: cost ?? 0, sampled: cost !== undefined,
  starve: 0, verdict: VERDICT_NONE, spent: 0,
});

/**
 * @description 找一个 tick，使给定进程键在该 tick 满足维护层的周期条件。
 * @param key 进程键。
 * @returns tick。
 */
const phaseTick = (key: string): number => {
  for (let t = 1000; ; t += 1) if ((t + hashString(key)) % MAINTENANCE_PERIOD === 0) return t;
};

describe('预算', () => {
  test.each([
    ['bucket 等于目标', 5000, 20, 20],
    ['bucket 高于目标时透支', 10000, 20, 25],
    ['bucket 很低时最多少花 20%', 0, 20, 16],
  ])('%s', (_label, bucket, limit, b) => {
    Object.assign(port, { bucket, limit });
    const cpu = createCpu(fake);
    cpu.beginTick();
    cpu.settle([]);
    expect(cpu.summary().budget).toBe(b);
    expect(cpu.summary().reserve).toBe(Math.max(2, b * 0.1));
    expect(cpu.hardEnd()).toBe(500 - Math.max(2, b * 0.1));
  });

  test('收尾预留至少 2 CPU；额度不是有限数时以 tickLimit 为额度', () => {
    Object.assign(port, { limit: 10 });
    const cpu = createCpu(fake);
    cpu.beginTick(); cpu.settle([]);
    expect(cpu.summary().reserve).toBe(2);
    Object.assign(port, { limit: Number.POSITIVE_INFINITY, tickLimit: 100 });
    cpu.beginTick(); cpu.settle([]);
    expect(cpu.summary().budget).toBe(100);
  });

  test('预算视图：生存层到 hardEnd，其余到 poolEnd', () => {
    const cpu = createCpu(fake);
    cpu.beginTick();
    port.used = 10;
    expect(cpu.budgets.survival.remaining()).toBe(500 - 2 - 10);
    expect(cpu.budgets.economy.remaining()).toBe(20 - 2 - 10);
    port.used = 18;
    expect([cpu.budgets.economy.shouldYield(), cpu.budgets.survival.shouldYield()]).toEqual([true, false]);
  });
});

describe('准入', () => {
  test('生存层总是准入并先计入预计值；其余按预计耗用预检', () => {
    const s = node('s', 'survival', 10);
    const a = node('a', 'economy', 5);
    const b = node('b', 'economy', 5);
    const cpu = createCpu(fake);
    cpu.beginTick();
    port.used = 1;
    cpu.admit([s, a, b]); // 1 + 10 + 5 = 16 ≤ 18；再加 5 超过
    expect([s.verdict, a.verdict, b.verdict]).toEqual([VERDICT_ADMIT, VERDICT_ADMIT, VERDICT_REJECT]);
    expect(b.starve).toBe(1);
  });

  test('不可运行的进程判为空闲，不累计落选', () => {
    const a = node('a', 'economy', 5);
    a.runnable = false;
    const cpu = createCpu(fake);
    cpu.beginTick();
    cpu.admit([a]);
    expect([a.verdict, a.starve]).toEqual([VERDICT_IDLE, 0]);
  });

  test('规划层要求 bucket ≥ 1500；维护层按进程键错峰', () => {
    const p = node('p', 'planning', 1);
    const m = node('m', 'maintenance', 1);
    const cpu = createCpu(fake);
    port.bucket = 1499;
    port.time = phaseTick('m') + 1;
    cpu.beginTick(); cpu.admit([p, m]);
    expect([p.verdict, m.verdict]).toEqual([VERDICT_IDLE, VERDICT_IDLE]);
    port.bucket = 1500;
    port.time = phaseTick('m');
    cpu.beginTick(); cpu.admit([p, m]);
    expect([p.verdict, m.verdict]).toEqual([VERDICT_ADMIT, VERDICT_ADMIT]);
  });

  test('LC-02：落选的实例排在所属模块之前时，先判定模块，预算充足时实例能重新准入', () => {
    const mod = node('mod', 'economy', 2);
    const inst = node('mod:a', 'economy', 3, { owner: mod });
    const cpu = createCpu(fake);
    cpu.beginTick();
    port.used = 14; // 14 + 2 = 16 ≤ 18；再加 3 超过
    cpu.admit([mod, inst]);
    expect([mod.verdict, inst.verdict, inst.starve]).toEqual([VERDICT_ADMIT, VERDICT_REJECT, 1]);
    port.used = 0;
    cpu.admit([mod, inst]); // inst 排在最前，judge 先判定 mod
    expect([mod.verdict, inst.verdict, inst.starve]).toEqual([VERDICT_ADMIT, VERDICT_ADMIT, 0]);
  });

  test('LC-02：同层依赖先判定；依赖落选时依赖方落选并计数，但不衰减', () => {
    const dep = node('dep', 'economy', 10);
    const user = node('user', 'economy', 1, { deps: [dep] });
    user.starve = 2; // 上一 tick 落选过，排在 dep 之前
    const cpu = createCpu(fake);
    cpu.beginTick();
    port.used = 10; // dep 放不下
    cpu.admit([dep, user]);
    expect([dep.verdict, user.verdict, user.starve, user.cost]).toEqual([VERDICT_REJECT, VERDICT_REJECT, 3, 1]);
    expect(dep.cost).toBeCloseTo(10 * (1 - CPU_EMA_ALPHA));
  });

  test('依赖空闲不阻挡：维护层模块与实例相位不同时，实例照常准入', () => {
    const mod = node('m', 'maintenance', 1);
    const inst = node('m:b', 'maintenance', 1, { owner: mod });
    expect(hashString('m') % MAINTENANCE_PERIOD).not.toBe(hashString('m:b') % MAINTENANCE_PERIOD);
    port.time = phaseTick('m:b');
    const cpu = createCpu(fake);
    cpu.beginTick();
    cpu.admit([mod, inst]);
    expect([mod.verdict, inst.verdict]).toEqual([VERDICT_IDLE, VERDICT_ADMIT]);
  });

  test('LC-03：自适应长计算在预算收缩后，经衰减重新准入', () => {
    const job = node('job', 'economy', 20); // bucket 高时的样本
    const cpu = createCpu(fake);
    let ticks = 0;
    do {
      cpu.beginTick(); // B = 20，poolEnd = 18
      cpu.admit([job]);
      cpu.settle([job]);
      ticks += 1;
    } while (job.verdict === VERDICT_REJECT && ticks < 10);
    expect(job.verdict).toBe(VERDICT_ADMIT);
    expect(ticks).toBe(2); // 20 × 0.8 = 16 ≤ 18
  });
});

describe('计量', () => {
  test('平滑耗用：首个样本为初值，之后按 α 平滑；摘要汇总各层耗用与计数；准入时清零 spent', () => {
    const a = node('a', 'economy');
    const s = node('s', 'survival');
    const cpu = createCpu(fake);
    cpu.beginTick();
    a.spent = 99; // 上一 tick 遗留
    cpu.admit([s, a]);
    expect(a.spent).toBe(0);
    a.spent = 4; s.spent = 1;
    cpu.settle([s, a]);
    expect([a.cost, a.sampled, a.spent]).toEqual([4, true, 0]);
    expect(cpu.summary().tiers).toEqual({ survival: 1, economy: 4, maintenance: 0, planning: 0 });
    expect([cpu.summary().admitted, cpu.summary().rejected]).toEqual([2, 0]);
    cpu.admit([s, a]);
    a.spent = 9;
    cpu.settle([s, a]);
    expect(a.cost).toBeCloseTo(4 + CPU_EMA_ALPHA * 5);
  });
});

test('ultrareview 第 8 项：维护层的错峰相位在构造时确定，准入不再逐 tick 计算哈希；每个进程每周期仍恰好准入一次', () => {
  const nodes = [node('m', 'maintenance', 1), node('m:a', 'maintenance', 1), node('m:b', 'maintenance', 1)];
  const cpu = createCpu(fake);
  const admitted = new Map(nodes.map((n) => [n.key, 0]));
  mockHashCalls.n = 0;
  for (let t = 0; t < MAINTENANCE_PERIOD * 2; t += 1) {
    port.time = 100 + t;
    cpu.beginTick();
    cpu.admit(nodes);
    for (const n of nodes) if (n.verdict === VERDICT_ADMIT) admitted.set(n.key, admitted.get(n.key)! + 1);
    cpu.settle(nodes);
  }
  expect(mockHashCalls.n).toBe(0);
  expect([...admitted.values()]).toEqual([2, 2, 2]);
});

test('ultrareview 第 3 项：被紧急刹车跳过的进程不记样本、不计准入，连续落选次数加 1，预计值不衰减；层耗用仍计入已花掉的部分', () => {
  const job = node('job', 'economy', 5);
  const cpu = createCpu(fake);
  cpu.beginTick();
  cpu.admit([job]);
  expect(job.verdict).toBe(VERDICT_ADMIT);
  job.spent = 1; // 已运行前面的阶段，之后被刹车跳过
  cpu.brake(job);
  cpu.brake(job); // 同一 tick 只计一次
  cpu.settle([job]);
  expect([job.verdict, job.starve, job.cost]).toEqual([VERDICT_REJECT, 1, 5]);
  expect(cpu.summary()).toMatchObject({ admitted: 0, rejected: 1, tiers: { economy: 1 } });
});
