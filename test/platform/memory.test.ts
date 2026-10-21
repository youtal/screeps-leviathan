/**
 * 文件摘要：Memory 与 segment 平台模拟（test/platform/memory.ts）的单元测试。
 * 逐条核对模拟与引擎、驱动源码一致的语义：Memory 惰性解析与 tick 末写回、RawMemory.set 的优先级与上限、
 * 用户代码抛错时仍然持久化、segment 激活延迟一 tick 且请求持续生效、保存数量与长度上限、
 * Game.cpu.halt() 使本 tick 的运行结果整体作废。
 */
import { PlatformError, SEGMENT_LIMIT, createMemoryPlatform } from './memory';
import type { MemoryPlatform } from './memory';

// 每个测试使用独立的目标对象，避免污染 Jest 的全局对象。
const scope = (): Record<string, any> => ({});

// 正常 tick 必须将回调里的断言失败传回 Jest；预期用户代码抛错的用例直接检查 tick 返回的 error。
const tickWithoutError = (platform: MemoryPlatform, run: () => void): void => {
  const { error } = platform.tick(run);
  if (error !== undefined) {
    throw error;
  }
};

describe('Memory 与 RawMemory', () => {
  test('正常 tick 的回调断言失败会传回测试调用方', () => {
    const platform = createMemoryPlatform({ target: scope() });
    expect(() => tickWithoutError(platform, () => expect(false).toBe(true))).toThrow('Expected: true');
  });

  test('首次读取 Memory 时解析原始文本，结果没有原型，tick 末写回', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '{"a":1}', target });
    tickWithoutError(platform, () => {
      expect(Object.getPrototypeOf(target.Memory)).toBeNull();
      target.Memory.b = 2;
    });
    expect(platform.memory).toBe('{"a":1,"b":2}');
  });

  test('空的原始文本按 {} 解析；未读取 Memory 的 tick 不改写原始文本', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '', target });
    tickWithoutError(platform, () => undefined);
    expect(platform.memory).toBe('');
    tickWithoutError(platform, () => expect({ ...target.Memory }).toEqual({}));
    expect(platform.memory).toBe('{}');
  });

  test('原始文本无法解析时 Memory 为 null，原始文本保持不变', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '{bad', target });
    tickWithoutError(platform, () => expect(target.Memory).toBeNull());
    expect(platform.memory).toBe('{bad');
  });

  test('RawMemory.set 丢弃已解析的 Memory，以设置的文本为准', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '{}', target });
    tickWithoutError(platform, () => {
      target.Memory.lost = true;
      target.RawMemory.set('{"kept":true}');
    });
    expect(platform.memory).toBe('{"kept":true}');
  });

  test('set 之后再访问同一 Memory 对象不会恢复写回，因为访问器已被替换为值', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '{}', target });
    tickWithoutError(platform, () => {
      const memory = target.Memory;
      target.RawMemory.set('{"x":1}');
      memory.y = 2;
    });
    expect(platform.memory).toBe('{"x":1}');
  });

  test('删除全局 Memory 后换成临时对象，引擎不再写回', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '{"real":1}', target });
    tickWithoutError(platform, () => {
      delete target.Memory;
      target.Memory = { temp: true };
    });
    expect(platform.memory).toBe('{"real":1}');
  });

  test('RawMemory.set 拒绝非字符串与超过 2 MB 的文本', () => {
    const target = scope();
    const platform = createMemoryPlatform({ target });
    tickWithoutError(platform, () => {
      expect(() => target.RawMemory.set({})).toThrow('not a string');
      expect(() => target.RawMemory.set('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MB');
    });
  });

  test('用户代码抛错时仍然持久化，并返回该异常', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '{}', target });
    const failure = new Error('boom');
    const result = platform.tick(() => {
      target.Memory.saved = true;
      throw failure;
    });
    expect(result.error).toBe(failure);
    expect(platform.memory).toBe('{"saved":true}');
  });

  test('每个 tick 重新安装 Memory 访问器', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '{"n":1}', target });
    tickWithoutError(platform, () => {
      target.Memory.n = 2;
    });
    tickWithoutError(platform, () => expect(target.Memory.n).toBe(2));
  });
});

describe('segment', () => {
  test('激活请求在下一 tick 生效，并持续到再次调用', () => {
    const target = scope();
    const platform = createMemoryPlatform({ segments: { 3: 'three' }, target });
    tickWithoutError(platform, () => {
      expect(target.RawMemory.segments[3]).toBeUndefined();
      target.RawMemory.setActiveSegments([3, 4]);
    });
    expect(platform.activeSegments).toEqual([3, 4]);
    tickWithoutError(platform, () => {
      expect(target.RawMemory.segments[3]).toBe('three');
      expect(target.RawMemory.segments[4]).toBe('');
    });
    tickWithoutError(platform, () => expect(Object.keys(target.RawMemory.segments)).toEqual(['3', '4']));
  });

  test('未激活的页也可以写入；写入在 tick 末保存', () => {
    const target = scope();
    const platform = createMemoryPlatform({ target });
    tickWithoutError(platform, () => {
      target.RawMemory.segments[50] = 'stats';
    });
    expect(platform.segment(50)).toBe('stats');
  });

  test('setActiveSegments 拒绝超过 10 个或越界的页号', () => {
    const target = scope();
    const platform = createMemoryPlatform({ target });
    tickWithoutError(platform, () => {
      expect(() => target.RawMemory.setActiveSegments([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toThrow('Only 10');
      expect(() => target.RawMemory.setActiveSegments([100])).toThrow('not a valid segment ID');
      expect(() => target.RawMemory.setActiveSegments('1')).toThrow('not an array');
    });
  });

  test('激活页计入单 tick 的保存数量：10 个激活页再写 1 页时整个 tick 失败，写入全部丢弃', () => {
    const target = scope();
    const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const platform = createMemoryPlatform({ memory: '{}', target });
    tickWithoutError(platform, () => target.RawMemory.setActiveSegments(ids));
    expect(() =>
      platform.tick(() => {
        target.Memory.changed = true;
        target.RawMemory.segments[20] = 'extra';
      }),
    ).toThrow(PlatformError);
    expect(platform.memory).toBe('{}');
    expect(platform.segment(20)).toBeUndefined();
  });

  test('超过 100 KB 或不是字符串的页使整个 tick 失败', () => {
    const target = scope();
    const platform = createMemoryPlatform({ target });
    expect(() =>
      platform.tick(() => {
        target.RawMemory.segments[1] = 'x'.repeat(SEGMENT_LIMIT + 1);
      }),
    ).toThrow('100 KB');
    expect(() =>
      platform.tick(() => {
        target.RawMemory.segments[1] = 42;
      }),
    ).toThrow('not a string');
    expect(platform.segment(1)).toBeUndefined();
  });
});

describe('Game.cpu.halt()', () => {
  test('halt 的 tick 不保存 Memory、segment 与激活请求，下一 tick 看到的是 halt 之前的状态', () => {
    const target = scope();
    const platform = createMemoryPlatform({ memory: '{"a":1}', target });
    const { error } = platform.tick(() => {
      target.Memory.a = 2;
      target.RawMemory.segments[3] = 'page';
      target.RawMemory.setActiveSegments([3]);
    }, { halt: true });
    expect(error).toBeUndefined();
    expect(platform.memory).toBe('{"a":1}');
    expect(platform.segment(3)).toBeUndefined();
    expect(platform.activeSegments).toEqual([]);
    tickWithoutError(platform, () => {
      expect(target.Memory.a).toBe(1);
      expect(Object.keys(target.RawMemory.segments)).toEqual([]);
    });
  });
});
