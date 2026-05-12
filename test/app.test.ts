describe('App composition', () => {
  beforeEach(() => {
    jest.resetModules();
    (global as any).Game = {
      rooms: {},
      flags: {},
      creeps: {},
      powerCreeps: {},
      getObjectById: jest.fn(),
      notify: jest.fn(),
      cpu: { getUsed: jest.fn(() => 0) },
    };
    (global as any).Memory = {};
  });

  it('should expose the app context factory and assembled modules', () => {
    const app = require('@/app');

    expect(typeof app.createContext).toBe('function');
    expect(typeof app.roomShortcuts.getSpawn).toBe('function');
    expect(typeof app.roomShortcuts.getStorage).toBe('function');
  });

  it('should create contexts that share the app bus', () => {
    const { createContext } = require('@/app/runtime');
    const alpha = createContext('Alpha');
    const beta = createContext('Beta');
    const listener = jest.fn();

    alpha.bus.subscribe({ scope: 'global' }, 'creep:death', 'beta', listener);
    beta.bus.publish({ scope: 'global' }, 'creep:death', {
      creepName: 'Fallen',
    });

    expect(listener).toHaveBeenCalledWith({ creepName: 'Fallen' });
  });
});
