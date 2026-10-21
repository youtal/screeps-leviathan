/**
 * 文件摘要：真实入口与装配的冒烟测试：以最小全局 Game 与 Memory 平台替身运行 src/main.ts 的 loop。
 * 验证 Memory 接管、createGamePlatform、kernel 与 app.boot 的整条链路连续多个 tick 不报错：
 * 没有任何资产时判为 DORMANT、空存储保持不变；已初始化的存储判为 NORMAL，只有项目标记按 6.7 更新；控制台没有错误输出。
 * 另测日志输出端的选择：存在 console.logUnsafe 时经它输出彩色前缀，否则经 console.log 输出纯文本；
 * 以及 Memory 抽查数与实例计时取自使用者设置（审计 PA-04）。
 */
import { assemble, createGameServices } from '@/app/assembly';
import * as lifecycle from '@/kernel/lifecycle';
import { ENTRY_KEY, loop } from '@/main';
import { memorySettings, profilerSettings } from '@/settings';
import { createMemoryPlatform } from '../platform/memory';

const marker = {
  sig: 'leviathan', schema: 1, shard: 'x', epoch: 0, lastRun: 1, release: 'test',
  fp: { rooms: [], spawnIds: [], creepCount: 0 },
  mode: { mode: 'FRESH_START', strength: 'strong', since: 1, evidence: [] },
};

/**
 * @description 安装最小的全局 Game：时间、CPU、空的对象表，以及记录通知的 notify。
 * @param time 当前 tick。
 * @returns 无返回值。
 */
const installGame = (time: number): void => {
  (globalThis as Record<string, unknown>).Game = {
    time, creeps: {}, flags: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, powerCreeps: {},
    shard: { name: 'shard0' },
    cpu: { limit: 20, tickLimit: 500, bucket: 10000, getUsed: () => 0 },
    /**
     * @description 记录游戏通知。
     * @param message 通知正文。
     * @returns 无返回值。
     */
    notify: (message: string) => { notices.push(message); },
  };
};

/** 本文件中 Game.notify 收到的通知。 */
const notices: string[] = [];

/**
 * @description 加载一份全新的入口模块，模拟一次新的 global：入口在模块级 heap 中持有 kernel，并登记在全局注册表
 * globalThis[ENTRY_KEY]（同一 global 中模块重新执行时沿用）。测试进程共用 globalThis，调用方须先移除上一段的
 * 控制台命名空间与注册表登记，否则相当于同一 global 中的模块重新执行。
 * @returns 新入口的 loop。
 */
const freshLoop = (): (() => void) => {
  let fresh: (() => void) | undefined;
  jest.isolateModules(() => { fresh = (require('@/main') as typeof import('@/main')).loop; });
  return fresh!;
};

test('真实 loop 连续运行：没有资产时判为 DORMANT 且不初始化；已初始化的存储判为 NORMAL，只更新项目标记；无错误输出', () => {
  const lines: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  const empty = createMemoryPlatform({ target: globalThis });
  for (let t = 1; t <= 3; t += 1) {
    installGame(t);
    expect(empty.tick(() => loop()).error).toBeUndefined();
  }
  expect(empty.memory).toBe('');
  expect(notices.some((n) => n.includes('DORMANT'))).toBe(true);

  // 新的 global：入口重新装配 kernel，从这份存储加载 Memory。
  const text = JSON.stringify({ leviathan: { sys: marker, part: {}, rooms: {}, creeps: {}, flags: {} } });
  const ready = createMemoryPlatform({ target: globalThis, memory: text });
  // 新 global 的全局作用域中没有上一段安装的控制台命名空间与入口登记；测试进程共用 globalThis，手动移除。
  for (const name of ['boot', 'ops']) delete (globalThis as Record<string, unknown>)[name];
  delete (globalThis as Record<symbol, unknown>)[ENTRY_KEY];
  const second = freshLoop();
  for (let t = 4; t <= 6; t += 1) {
    installGame(t);
    expect(ready.tick(() => second()).error).toBeUndefined();
  }
  const saved = JSON.parse(ready.memory).leviathan;
  // 除项目标记与 kernel、boot 自己的分区外，存储内容不变。
  expect({ ...saved, sys: undefined, part: undefined }).toEqual({ ...JSON.parse(text).leviathan, sys: undefined, part: undefined });
  expect(saved.sys).toMatchObject({ lastRun: 6, release: '0.0.0-test', mode: { mode: 'NORMAL', strength: 'strong', since: 4 } });
  expect(notices.some((n) => n.includes('NORMAL'))).toBe(true);
  expect(lines.filter((l) => l.includes('ERROR'))).toEqual([]);
  jest.restoreAllMocks();
});

test('LC-01：身份用的 shard 名只在提供 InterShardMemory 时取 Game.shard.name，私服注入的主机名不作为身份', () => {
  installGame(8);
  const g = globalThis as Record<string, unknown>;
  (g.Game as { shard: { name: string } }).shard = { name: 'screeps-server-1' };
  delete g.InterShardMemory;
  expect(createGameServices().game.shard()).toBe('x');
  (g.Game as { shard: { name: string } }).shard = { name: 'shard3' };
  g.InterShardMemory = { getLocal: () => '' };
  expect(createGameServices().game.shard()).toBe('shard3');
  delete g.InterShardMemory;
});

test('日志输出端：存在 console.logUnsafe 时经它输出并上色，否则经 console.log 输出纯文本', () => {
  installGame(7);
  const unsafe: string[] = [];
  const plain: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((line: unknown) => { plain.push(String(line)); });
  const host = console as { logUnsafe?: (line: string) => void };
  host.logUnsafe = (line) => { unsafe.push(line); };
  createGameServices().logRoot.scope('m').info('a<b');
  delete host.logUnsafe;
  createGameServices().logRoot.scope('m').info('a<b');
  expect(unsafe).toEqual(['<span style="color:#95a5a6">[7] INFO</span> m: a&lt;b']);
  expect(plain).toEqual(['[7] INFO m: a<b']);
  jest.restoreAllMocks();
});

test('PA-04：装配把使用者设置中的 Memory 抽查数与实例计时注入 kernel', () => {
  installGame(9);
  const create = jest.spyOn(lifecycle, 'createKernel');
  const memory = memorySettings as { auditUnits: number };
  const profiler = profilerSettings as { instances: boolean };
  const saved = { auditUnits: memory.auditUnits, instances: profiler.instances };
  try {
    memory.auditUnits = 4;
    profiler.instances = true;
    const entry = { time: 9, cooldown: 0, crashes: 0, degraded: 0, paused: 0, lastFailure: undefined };
    assemble(createGameServices(), () => entry).dispose();
    const options = create.mock.calls[0][0];
    expect(options.memory.auditUnits).toBe(4);
    expect(options.profileInstances).toBe(true);
  } finally {
    memory.auditUnits = saved.auditUnits;
    profiler.instances = saved.instances;
    jest.restoreAllMocks();
  }
  // 默认关闭：发布构建不承担抽查与实例计时的成本。
  expect(saved).toEqual({ auditUnits: 0, instances: false });
});
