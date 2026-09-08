import { createMemoryAccessor } from '@/core/profiler/memory';
import { createProfiler } from '@/core/profiler';
import type { EnvMethods } from '@/core/runtime/types';
import type { ProfilerMemory } from '@/core/profiler';

const createMockLog = () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  info: jest.fn(),
  report: jest.fn(),
});

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
