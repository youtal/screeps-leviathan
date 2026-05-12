import { createBus } from '@/core/eventBus';
import { createRuntime, createEnvMethods } from '@/core/runtime';
import type { Profiler, ProfilerMemory } from '@/core/profiler';

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

  it('should share bus and profiler while creating module-specific env', () => {
    const bus = createBus();
    const profiler: Profiler = {
      wrap: jest.fn(<F extends (...args: any[]) => any>(_: string, fn: F) => fn),
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

  it('should create default profiler memory in Memory.profiler', () => {
    const createContext = createRuntime({ enableProfiler: true });
    const context = createContext('Worker');
    const wrapped = context.profiler!.wrap('task', () => 'done');

    jest
      .spyOn(Game.cpu, 'getUsed')
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(6);

    expect(wrapped()).toBe('done');
    expect(Memory.profiler).toEqual({
      task: { totalTime: 5, selfTime: 5, calls: 1 },
    });
  });

  it('should use injected profiler memory accessor', () => {
    const memory: ProfilerMemory = {};
    const createContext = createRuntime({
      enableProfiler: true,
      getProfilerMemory: () => memory,
    });
    const context = createContext('Worker');

    jest
      .spyOn(Game.cpu, 'getUsed')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(3);

    context.profiler!.wrap('custom', () => undefined)();

    expect(memory.custom).toEqual({ totalTime: 3, selfTime: 3, calls: 1 });
    expect(Memory.profiler).toBeUndefined();
  });
});
