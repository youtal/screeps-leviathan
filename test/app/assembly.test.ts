/**
 * 文件摘要：真实入口与装配的冒烟测试：以最小全局 Game 与 Memory 平台替身运行 src/main.ts 的 loop。
 * 验证 Memory 接管、createGamePlatform、kernel 与临时 boot 的整条链路连续多个 tick 不报错：
 * 空存储保持不变（临时 boot 不初始化），已初始化的存储内容不变，控制台没有错误输出。
 */
import { loop } from '@/main';
import { createMemoryPlatform } from '../platform/memory';

const marker = {
  sig: 'leviathan', schema: 1, shard: 'x', epoch: 0, lastRun: 1, release: 'test',
  fp: { rooms: [], spawnIds: [], creepCount: 0 },
  mode: { mode: 'FRESH_START', strength: 'strong', since: 1, evidence: [] },
};

/**
 * @description 安装最小的全局 Game：时间、CPU、空的 creep/flag/房间表。
 * @param time 当前 tick。
 * @returns 无返回值。
 */
const installGame = (time: number): void => {
  (globalThis as Record<string, unknown>).Game = {
    time, creeps: {}, flags: {}, rooms: {}, shard: { name: 'shard0' },
    cpu: { limit: 20, tickLimit: 500, bucket: 10000, getUsed: () => 0 },
  };
};

test('真实 loop 连续运行：空存储不被初始化，已初始化存储内容不变，无错误输出', () => {
  const lines: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  const empty = createMemoryPlatform({ target: globalThis });
  for (let t = 1; t <= 3; t += 1) {
    installGame(t);
    expect(empty.tick(() => loop()).error).toBeUndefined();
  }
  expect(empty.memory).toBe('');

  const text = JSON.stringify({ leviathan: { sys: marker, part: {}, rooms: {}, creeps: {}, flags: {} } });
  const ready = createMemoryPlatform({ target: globalThis, memory: text });
  for (let t = 4; t <= 6; t += 1) {
    installGame(t);
    expect(ready.tick(() => loop()).error).toBeUndefined();
  }
  expect(JSON.parse(ready.memory)).toEqual(JSON.parse(text));
  expect(lines.filter((l) => l.includes('ERROR'))).toEqual([]);
  jest.restoreAllMocks();
});
