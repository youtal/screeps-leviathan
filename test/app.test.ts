describe('App composition', () => {
  beforeEach(() => {
    jest.resetModules();
    (global as any).Game = {
      time: 1,
      rooms: {},
      flags: {},
      creeps: {},
      powerCreeps: {},
      getObjectById: jest.fn(),
      notify: jest.fn(),
      cpu: { getUsed: () => 0, limit: 20, tickLimit: 100, bucket: 10000 },
    };
    (global as any).Memory = {};
    let raw = '{}';
    (global as any).RawMemory = {
      get: () => raw,
      set: jest.fn((value: string) => {
        raw = value;
      }),
    };
  });

  it('exports the instance loop and initializes RoomShortcuts as a service', () => {
    const { framework } = require('@/app');
    const { loop } = require('@/index');
    expect(loop).toBe(framework.loop);
    let service: any;
    framework.register({
      manifest: { id: 'consumer', version: 1, requires: ['roomShortcuts'] },
      setup: (context: any) => {
        service = context.services.get('roomShortcuts');
      },
    });
    loop();
    expect(framework.getStatus().safeMode).toBe(false);
    expect(typeof service.getSpawn).toBe('function');
    expect(typeof service.getStorage).toBe('function');
    expect((global as any).RawMemory.set).toHaveBeenCalledTimes(1);
    Game.time++;
    loop();
    expect((global as any).RawMemory.set).toHaveBeenCalledTimes(1);
  });

  it('does not access Memory during module import', () => {
    const get = jest.fn(() => {
      throw new Error('eager Memory');
    });
    Object.defineProperty(global, 'Memory', { configurable: true, get });
    try {
      expect(() => require('@/app')).not.toThrow();
      expect(get).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(global, 'Memory', {
        configurable: true,
        writable: true,
        value: {},
      });
    }
  });
});
