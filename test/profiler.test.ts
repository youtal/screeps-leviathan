/**
 * 文件摘要：验证 Profiler（@/core/profiler 与 @/core/profiler/memory）的计时与持久化行为。
 *
 * 覆盖模块：createMemoryAccessor（读取/累加/清空统计记录，内存不可用时返回 null 并报错）
 * 与 createProfiler（wrap 包裹函数、totalTime/selfTime/calls 统计、父子调用的 selfTime
 * 扣减、enable/disable 对已包裹函数生效、保留 this、重复 label 拒绝、report 过滤与 reset）。
 * 覆盖边界：观测路径自身失败时（cpu 采样抛错、Memory 写入失败、getMemory 被整体替换）
 * 必须保留原始返回值与原始异常，并且不污染后续统计。
 *
 * 替代实现：EnvMethods 用最小桩替代真实 Game 与 logger，cpu.getUsed 通过数组按调用次序
 * 回放采样值；用 Proxy 拦截 defineProperty 模拟存储写入失败。不依赖 Screeps 全局对象，
 * 不写临时文件。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不需要 .secret.json，
 * 不执行构建与网络请求。
 */
import { createMemoryAccessor } from '@/core/profiler/memory';
import { createProfiler } from '@/core/profiler';
import type { EnvMethods } from '@/core/runtime/types';
import type { ProfilerMemory } from '@/core/profiler';

/** 全 jest.fn 的 logger：既能断言 report/warn 的调用与文案，又不会向测试输出刷日志。 */
const createMockLog = () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  info: jest.fn(),
  report: jest.fn(),
});

/**
 * 用数组按调用次序回放 cpu.getUsed 的采样值：wrap 会在调用前后各采样一次，
 * 两个值之差就是被断言的耗时。索引越界后固定返回最后一个值，避免断言失败时
 * 因为采样越界再抛出无关异常、掩盖真实原因。
 */
const createEnv = (cpuValues: number[]): EnvMethods => {
  const log = createMockLog();
  let index = 0;

  return {
    getGame: () =>
      ({
        cpu: {
          getUsed: () => cpuValues[index++] ?? cpuValues[cpuValues.length - 1],
        },
      }) as Game,
    getRoom: jest.fn(),
    getFlag: jest.fn(),
    getCreep: jest.fn(),
    getPowerCreep: jest.fn(),
    getObjectById: jest.fn(),
    log,
  };
};

describe('Profiler memory accessor', () => {
  it('should update, read and clear profiler memory', () => {
    const memory: ProfilerMemory = {};
    const log = createMockLog();
    const db = createMemoryAccessor(() => memory, log)!;

    expect(db.get('task')).toEqual({ totalTime: 0, selfTime: 0, calls: 0 });

    db.update('task', 2, 5);
    db.update('task', 3, 7);

    expect(db.get('task')).toEqual({ totalTime: 12, selfTime: 5, calls: 2 });
    expect(db.getAll()).toBe(memory);

    db.clear();
    expect(memory).toEqual({});
  });

  it('should return null and log if memory is unavailable', () => {
    const log = createMockLog();

    const db = createMemoryAccessor(
      () => undefined as unknown as ProfilerMemory,
      log
    );

    expect(db).toBeNull();
    expect(log.error).toHaveBeenCalledWith('无法获取 Profiler 内存');
  });
});

describe('Profiler', () => {
  /**
   * 构造两种观测故障：broken 的 defineProperty 抛错让统计写入失败，getter 的第二次
   * 调用抛错让 CPU 采样失败。无论哪种情况，业务异常与返回值都必须原样穿过 profiler：
   * 观测设施不能改变被观测代码的可观察行为。
   */
  it('preserves original errors and results when samples or storage fail', () => {
    const env = createEnv([0, 2, 3, 5]);
    const broken = new Proxy(
      {},
      {
        defineProperty() {
          throw new Error('storage');
        },
      }
    );
    const profiler = createProfiler({
      env,
      getMemory: () => broken,
      enable: true,
    })!;
    const original = new Error('business');
    expect(() =>
      profiler.wrap('failure', () => {
        throw original;
      })()
    ).toThrow(original);
    expect(profiler.wrap('success', () => 42)()).toBe(42);
    const getter = jest
      .fn()
      .mockImplementationOnce(() => 0)
      .mockImplementationOnce(() => {
        throw new Error('sample');
      })
      .mockReturnValue(5);
    const memory: ProfilerMemory = {};
    env.getGame = () => ({ cpu: { getUsed: getter } }) as unknown as Game;
    const sampled = createProfiler({
      env,
      getMemory: () => memory,
      enable: true,
    })!;
    expect(() =>
      sampled.wrap('bad', () => {
        throw original;
      })()
    ).toThrow(original);
    expect(sampled.wrap('next', () => 2)()).toBe(2);
    expect(memory.next.calls).toBe(1);
  });

  /** getMemory 每次重新定位当前命名空间：Memory 被整体替换后，旧闭包不得继续写已经废弃的对象。 */
  it('writes into the current Memory namespace after external replacement', () => {
    let current: ProfilerMemory = {};
    const env = createEnv([0, 1, 2, 3]);
    const profiler = createProfiler({
      env,
      getMemory: () => current,
      enable: true,
    })!;
    const fn = profiler.wrap('task', () => 1);
    fn();
    const old = current;
    current = {};
    fn();
    expect(old.task.calls).toBe(1);
    expect(current.task.calls).toBe(1);
  });

  it('should record wrapped function calls when enabled', () => {
    const memory: ProfilerMemory = {};
    const profiler = createProfiler({
      env: createEnv([1, 6]),
      getMemory: () => memory,
      enable: true,
    })!;
    const fn = jest.fn((value: number) => value + 1);

    const wrapped = profiler.wrap('task', fn);

    expect(wrapped(1)).toBe(2);
    expect(fn).toHaveBeenCalledWith(1);
    expect(memory.task).toEqual({ totalTime: 5, selfTime: 5, calls: 1 });
  });

  it('should keep stack consistent and record time when wrapped function throws', () => {
    const memory: ProfilerMemory = {};
    const profiler = createProfiler({
      env: createEnv([2, 9]),
      getMemory: () => memory,
      enable: true,
    })!;
    const wrapped = profiler.wrap('fail', () => {
      throw new Error('boom');
    });

    expect(() => wrapped()).toThrow('boom');
    expect(memory.fail).toEqual({ totalTime: 7, selfTime: 7, calls: 1 });
  });

  /** 采样序列 [0,2,5,9] 构成嵌套调用（父 0→9、子 2→5），用于验证 selfTime 必须扣掉子调用耗时后才是真正热点。 */
  it('should subtract child wrapped time from parent self time', () => {
    const memory: ProfilerMemory = {};
    const profiler = createProfiler({
      env: createEnv([0, 2, 5, 9]),
      getMemory: () => memory,
      enable: true,
    })!;
    const child = profiler.wrap('child', () => 'child');
    const parent = profiler.wrap('parent', () => child());

    expect(parent()).toBe('child');
    expect(memory.child).toEqual({ totalTime: 3, selfTime: 3, calls: 1 });
    expect(memory.parent).toEqual({ totalTime: 9, selfTime: 6, calls: 1 });
  });

  /** 开关必须在调用时判定而不是包裹时：否则运行中开启 profiler 就得重新包裹所有函数。 */
  it('should let enable and disable affect already wrapped functions', () => {
    const memory: ProfilerMemory = {};
    const profiler = createProfiler({
      env: createEnv([0, 4]),
      getMemory: () => memory,
      enable: false,
    })!;
    const wrapped = profiler.wrap('toggle', () => 'ok');

    expect(wrapped()).toBe('ok');
    expect(memory.toggle).toBeUndefined();

    profiler.enable();
    expect(wrapped()).toBe('ok');
    expect(memory.toggle).toEqual({ totalTime: 4, selfTime: 4, calls: 1 });

    profiler.disable();
    expect(wrapped()).toBe('ok');
    expect(memory.toggle).toEqual({ totalTime: 4, selfTime: 4, calls: 1 });
  });

  /** 包裹后仍以原对象为 this 调用，避免 this 丢失导致业务方法读写错误的目标。 */
  it('should preserve this when wrapping object methods', () => {
    const memory: ProfilerMemory = {};
    const profiler = createProfiler({
      env: createEnv([0, 3]),
      getMemory: () => memory,
      enable: false,
    })!;
    const worker = {
      energy: 10,
      consume(amount: number) {
        this.energy -= amount;
        return this.energy;
      },
    };

    worker.consume = profiler.wrap('worker.consume', worker.consume);

    expect(worker.consume(2)).toBe(8);
    profiler.enable();
    expect(worker.consume(3)).toBe(5);
    expect(memory['worker.consume']).toEqual({
      totalTime: 3,
      selfTime: 3,
      calls: 1,
    });
  });

  /** 一个 label 只能对应一个调用点：重复注册必须保持原函数不变并告警，否则统计会被静默覆盖而失去定位能力。 */
  it('should reject duplicate labels and report records', () => {
    const memory: ProfilerMemory = {
      slow: { totalTime: 10, selfTime: 8, calls: 2 },
      fast: { totalTime: 2, selfTime: 2, calls: 1 },
    };
    const env = createEnv([0, 1]);
    const profiler = createProfiler({
      env,
      getMemory: () => memory,
      enable: true,
    })!;
    const first = () => 'first';
    const duplicate = () => 'duplicate';

    profiler.wrap('dup', first);
    expect(profiler.wrap('dup', duplicate)).toBe(duplicate);
    expect(env.log.warn).toHaveBeenCalledWith(
      'Profiler: label "dup" 已被使用，未执行包裹'
    );

    profiler.report();
    expect(env.log.report).toHaveBeenCalledTimes(2);

    profiler.report(false, 'slow');
    expect(env.log.info).toHaveBeenCalledWith('Profiler 报告 (过滤器: slow)');

    profiler.reset();
    expect(memory).toEqual({});
  });
});
