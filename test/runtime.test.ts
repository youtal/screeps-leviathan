/**
 * 文件摘要：验证运行时环境工厂（@/core/runtime）的注入契约。
 *
 * 覆盖模块：createEnvMethods（env 查询访问器与带模块名前缀的 logger）与
 * createRuntime（按模块名创建独立 env，同时共享同一个 bus 与 profiler）。
 * 覆盖边界：env 查询返回的必须是 Game 上的对象引用、日志带 [模块名] 前缀、
 * 模块间通过共享总线通信而 env 互不共用、profiler 默认不写 global Memory、
 * 可通过 ProfilerStorage 把统计落点与标脏动作整体委托给宿主。
 *
 * 替代实现：beforeEach 向 global 注入最小 Game/Memory 桩；bus 与 profiler 用
 * 内存实现或 jest.fn 替代（Profiler 只声明 wrap/enable/disable/reset/report），
 * cpu.getUsed 用 jest.fn 按调用次序返回采样值，使耗时统计可在无真实 CPU 的情况下精确断言。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不需要 .secret.json，
 * 不执行构建与网络请求。
 */
import { createBus } from '@/core/eventBus';
import { createLogging } from '@/core/logger';
import { createRuntime, createEnvMethods } from '@/core/runtime';
import type { Profiler } from '@/contracts';
import type { ProfilerMemory } from '@/core/profiler';

/**
 * 注入最小 Game/Memory：rooms/flags/creeps/powerCreeps 各放一个命名对象，
 * 便于断言 env 的各个 getter 返回的就是 Game 上的引用（而不是复制或包装）。
 */
const installGame = () => {
  const object = { id: 'object-id' };
  (global as any).Game = {
    rooms: { W1N1: { name: 'W1N1' } },
    flags: { Flag1: { name: 'Flag1' } },
    creeps: { Bob: { name: 'Bob' } },
    powerCreeps: { PowerBob: { name: 'PowerBob' } },
    getObjectById: jest.fn(() => object),
    notify: jest.fn(),
    cpu: { getUsed: jest.fn(() => 0) },
  };
  (global as any).Memory = {};

  return object;
};

describe('Runtime env', () => {
  beforeEach(() => {
    installGame();
  });

  it('should create module env methods backed by Game and module logger', () => {
    const env = createEnvMethods(
      'TestModule',
      createLogging(),
      { info: true },
      true
    );
    const object = Game.getObjectById('object-id' as Id<_HasId>);

    expect(env.getGame()).toBe(Game);
    expect(env.getRoom('W1N1')).toBe(Game.rooms.W1N1);
    expect(env.getFlag('Flag1')).toBe(Game.flags.Flag1);
    expect(env.getCreep('Bob')).toBe(Game.creeps.Bob);
    expect(env.getPowerCreep('PowerBob')).toBe(Game.powerCreeps.PowerBob);
    expect(env.getObjectById('object-id' as Id<_HasId>)).toBe(object);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    env.log.info('hello');

    expect(logSpy.mock.calls[0].join(' ')).toContain('[TestModule]');
  });
});

describe('Runtime context factory', () => {
  beforeEach(() => {
    installGame();
  });

  /** 平台配置与模块配置保持分组：Game 访问走 platform，false 明确关闭 Profiler。 */
  it('applies grouped platform and profiler options', () => {
    let fakeGame = { ...Game, time: 42 } as Game;
    const runtime = createRuntime({
      platform: { getGame: () => fakeGame },
      profiler: false,
    });
    const context = runtime.createContext('Grouped');

    expect(runtime.getGame()).toBe(fakeGame);
    expect(context.env.getGame()).toBe(fakeGame);
    expect(context.profiler).toBeNull();
    fakeGame = { ...fakeGame, time: 43 };
    expect(runtime.getGame()).toBe(fakeGame);
    expect(context.env.getGame()).toBe(fakeGame);
  });

  it('forwards logging and lazy error mapper configuration', () => {
    const write = jest.fn();
    const report = jest.fn();
    const loadSourceMap = jest.fn(() => ({
      version: 3,
      sources: ['src/task.ts'],
      names: [],
      mappings: 'AAAA',
    }));
    const runtime = createRuntime({
      logging: { levels: { info: true }, output: { write } },
      errorMapper: { loadSourceMap, report },
      profiler: false,
    });
    expect(loadSourceMap).not.toHaveBeenCalled();
    runtime.createContext('Worker').env.log.info('ready');
    expect(write).toHaveBeenCalledWith(expect.stringContaining('[Worker]'));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('ready'));

    const error = new Error('failed');
    error.stack = 'Error: failed\n    at task (main:1:1)';
    const result = runtime.errorMapper.capture(
      { tick: 1, pluginId: 'Worker', phase: 'tickExecute' },
      () => { throw error; }
    );
    expect(result.ok).toBe(false);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'Worker',
      mappedStack: expect.stringContaining('src/task.ts:1:1'),
    }));
    runtime.errorMapper.mapStack(error.stack);
    expect(loadSourceMap).toHaveBeenCalledTimes(1);
  });

  it('forwards memory platform options without accessing storage during assembly', () => {
    const platform = {
      readRaw: jest.fn(() => '{}'),
      writeRaw: jest.fn(),
      readSegments: jest.fn(() => ({})),
      writeSegment: jest.fn(),
      activeSegments: jest.fn(() => [] as number[]),
      activateSegments: jest.fn(),
    };
    const runtime = createRuntime({
      memoryManager: { platform, segmentIds: [7] },
      profiler: false,
    });
    const context = runtime.createContext('Worker');
    expect(platform.readRaw).not.toHaveBeenCalled();
    expect(platform.readSegments).not.toHaveBeenCalled();
    runtime.memory.begin(1);
    expect(platform.readRaw).toHaveBeenCalledTimes(1);
    expect(platform.activateSegments).toHaveBeenCalledWith([7]);
    const state = context.memory('main', {
      version: 1, layer: 'critical', initialize: () => ({ count: 0 }),
    }).access();
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') throw new Error('Expected ready partition');
    state.commit((data) => data.count++);
    runtime.memory.end(1);
    const saved = JSON.parse(platform.writeRaw.mock.calls[0][0]);
    expect(saved.memoryManager.rawPartitions.Worker.main.payload.count).toBe(1);
  });

  /** 替换项优先于创建配置，未使用的配置不能触发校验、访问存储或创建第二个实例。 */
  it('prefers supplied instances over module configuration', () => {
    const supplied = createRuntime();
    const getMemory = jest.fn(() => { throw new Error('unused storage'); });
    const runtime = createRuntime({
      logging: { notifyInterval: -1 },
      profiler: { enabled: true, storage: { getMemory } },
    }, supplied);
    for (const key of ['logging', 'bus', 'memory', 'profiler', 'errorMapper'] as const)
      expect(runtime[key]).toBe(supplied[key]);
    expect(runtime.createContext('Worker').profiler).toBe(supplied.profiler);
    expect(getMemory).not.toHaveBeenCalled();

    expect(createRuntime({ profiler: { storage: { getMemory } } }, {
      profiler: null,
    }).profiler).toBeNull();
    expect(createRuntime({ profiler: false }, {
      profiler: supplied.profiler,
    }).profiler).toBe(supplied.profiler);
    expect(getMemory).not.toHaveBeenCalled();
  });

  it('creates a profiler with sampling off that can later be enabled', () => {
    const memory: ProfilerMemory = {};
    const runtime = createRuntime({
      profiler: { enabled: false, storage: { getMemory: () => memory } },
    });
    expect(runtime.profiler).not.toBeNull();
    const wrapped = runtime.profiler!.wrap('task', () => 42);
    expect(wrapped()).toBe(42);
    expect(Game.cpu.getUsed).not.toHaveBeenCalled();
    expect(memory).toEqual({});
    runtime.profiler!.enable();
    expect(wrapped()).toBe(42);
    expect(memory.task.calls).toBe(1);
  });

  /**
   * 两个模块上下文共享同一总线，但各自持有独立 env：
   * 由 Beta 发布、Alpha 订阅来验证跨模块通信确实走同一实例，而不是各自新建总线。
   */
  it('should share bus and profiler while creating module-specific env', () => {
    const bus = createBus(createLogging());
    const profiler: Profiler = {
      wrap: jest.fn(
        <F extends (...args: any[]) => any>(_: string, fn: F) => fn
      ),
      enable: jest.fn(),
      disable: jest.fn(),
      reset: jest.fn(),
      report: jest.fn(),
    };
    const runtime = createRuntime({}, { bus, profiler });

    const alpha = runtime.createContext('Alpha');
    const beta = runtime.createContext('Beta');

    expect(alpha.bus).toBe(bus);
    expect(beta.bus).toBe(bus);
    expect(alpha.profiler).toBe(profiler);
    expect(beta.profiler).toBe(profiler);
    expect(alpha.env).not.toBe(beta.env);

    const listener = jest.fn();
    alpha.bus.subscribe({ scope: 'global' }, 'creep:spawn', 'beta', listener);
    beta.bus.publish({ scope: 'global' }, 'creep:spawn', {
      creepName: 'Worker1',
    });

    expect(listener).toHaveBeenCalledWith({ creepName: 'Worker1' });
  });

  /**
   * 默认 profiler 只在 Runtime 的普通内存对象里保存统计：断言 Memory.profiler
   * 未定义，防止与游戏业务 Memory 抢占命名空间（那也会放大每 tick 的序列化成本）。
   */
  it('should keep default profiler data out of global Memory', () => {
    const runtime = createRuntime({ profiler: { enabled: true } });
    const context = runtime.createContext('Worker');
    const wrapped = context.profiler!.wrap('task', () => 'done');

    // wrap 在调用前后各采样一次 getUsed，差值即耗时；
    // 按次序返回两个值即可构造确定的样本。
    jest
      .spyOn(Game.cpu, 'getUsed')
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(6);

    expect(wrapped()).toBe('done');
    expect((Memory as any).profiler).toBeUndefined();
  });

  /** 注入访问器与 dirty 标记后，持久化写回由宿主负责；用普通对象与 jest.fn 直接观察写入结果与标脏次数。 */
  it('should use injected profiler memory accessor', () => {
    const memory: ProfilerMemory = {};
    const markDirty = jest.fn();
    const runtime = createRuntime({
      profiler: {
        enabled: true,
        storage: {
          getMemory: () => memory,
          markDirty,
        },
      },
    });
    const context = runtime.createContext('Worker');

    jest
      .spyOn(Game.cpu, 'getUsed')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(3);

    context.profiler!.wrap('custom', () => undefined)();

    expect(memory.custom).toEqual({ totalTime: 3, selfTime: 3, calls: 1 });
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect((Memory as any).profiler).toBeUndefined();
  });
});
