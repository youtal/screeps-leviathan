/**
 * 文件摘要：takeoverMemory 与宿主 ready()/failed() 的测试（内核设计第 6 节、审计 KS-08）。
 * 覆盖入口先行接管后 beginTick 正常工作、同 tick 重复接管无副作用、临时对象的写入不持久化、
 * Memory 已被读取后接管报错，以及 ready()/failed() 在空存储、初始化后、加载失败与销毁时的取值。
 */
import { createMemory, takeoverMemory } from '@/kernel/memory';
import { createMemoryPlatform } from '../../platform/memory';
import { harness, marker } from './harness';

test('入口先接管后 beginTick 正常工作；同 tick 重复接管保持同一临时对象；临时写入不持久化', () => {
  const h = harness();
  h.tick(1, () => { h.memory.initialize(marker); h.memory.commit(); });
  const text = h.platform.memory;
  const result = h.platform.tick(() => {
    takeoverMemory(h.target);
    const first = h.target.Memory as Record<string, unknown>;
    takeoverMemory(h.target);
    expect(h.target.Memory).toBe(first);
    first.creeps = { spawned: {} };
    expect(h.memory.beginTick({ time: 2, creeps: new Set(), flags: new Set() })).toBe('ready');
    expect(h.target.Memory).toBe(first);
  });
  expect(result.error).toBeUndefined();
  expect(h.platform.memory).toBe(text);
});

test('Memory 已被读取后再接管报错', () => {
  const target = {} as { Memory: unknown; RawMemory: RawMemory };
  const platform = createMemoryPlatform({ target });
  const result = platform.tick(() => {
    void target.Memory;
    takeoverMemory(target);
  });
  expect(String(result.error)).toContain('接管过晚');
});

test('ready 与 failed：空存储、初始化后、加载失败与销毁', () => {
  const h = harness();
  h.tick(1, () => {
    expect([h.memory.ready(), h.memory.failed()]).toEqual([false, false]);
    h.memory.initialize(marker);
    expect(h.memory.ready()).toBe(true);
  });
  h.memory.dispose();
  expect(h.memory.ready()).toBe(false);

  const target = {} as { Memory: unknown; RawMemory: RawMemory };
  const platform = createMemoryPlatform({ target, memory: '{bad' });
  const memory = createMemory({ namespace: 'leviathan', signature: 'leviathan', schema: 1,
    platform: { target, read: () => target.RawMemory.get(), write: (v) => target.RawMemory.set(v), warn: () => undefined } });
  platform.tick(() => { expect(() => memory.beginTick({ time: 1, creeps: new Set(), flags: new Set() })).toThrow(); });
  expect([memory.ready(), memory.failed()]).toEqual([false, true]);
});
