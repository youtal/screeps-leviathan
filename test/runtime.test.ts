/**
 * 文件摘要：验证运行时环境工厂（@/core/runtime）的注入契约。
 *
 * 覆盖模块：createEnvMethods（env 查询访问器与带模块名前缀的 logger）与
 * createRuntime（按模块名创建独立 env，同时共享同一个 bus 与 profiler）。
 * 覆盖边界：env 查询返回的必须是 Game 上的对象引用、日志带 [模块名] 前缀、
 * 模块间通过共享总线通信而 env 互不共用、profiler 默认不写 global Memory、
 * 可通过 getProfilerMemory / markProfilerMemoryDirty 把持久化写回委托给宿主。
 *
 * 替代实现：beforeEach 向 global 注入最小 Game/Memory 桩；bus 与 profiler 用
 * 内存实现或 jest.fn 替代（Profiler 只声明 wrap/enable/disable/reset/report），
 * cpu.getUsed 用 jest.fn 按调用次序返回采样值，使耗时统计可在无真实 CPU 的情况下精确断言。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不需要 .secret.json，
 * 不执行构建与网络请求。
 */
import { createBus } from '@/core/eventBus';
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
    const env = createEnvMethods('TestModule', { info: true }, true);
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

  /**
   * 两个模块上下文共享同一总线，但各自持有独立 env：
   * 由 Beta 发布、Alpha 订阅来验证跨模块通信确实走同一实例，而不是各自新建总线。
   */
  it('should share bus and profiler while creating module-specific env', () => {
    const bus = createBus();
    const profiler: Profiler = {
      wrap: jest.fn(
        <F extends (...args: any[]) => any>(_: string, fn: F) => fn
      ),
      enable: jest.fn(),
      disable: jest.fn(),
      reset: jest.fn(),
      report: jest.fn(),
    };
    const createContext = createRuntime({ bus, profiler });

    const alpha = createContext('Alpha');
    const beta = createContext('Beta');

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
   * 默认 profiler 必须把统计写进框架自己的 Memory 分区：断言 Memory.profiler
   * 未定义，防止与游戏业务 Memory 抢占命名空间（那也会放大每 tick 的序列化成本）。
   */
  it('should keep default profiler data out of global Memory', () => {
    const createContext = createRuntime({ enableProfiler: true });
    const context = createContext('Worker');
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
    const createContext = createRuntime({
      enableProfiler: true,
      getProfilerMemory: () => memory,
      markProfilerMemoryDirty: markDirty,
    });
    const context = createContext('Worker');

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
