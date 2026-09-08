import { createRoomShortcuts } from '@/modules/roomShortcuts/createRoomShortcuts';
import type { ModuleContext } from '@/core/runtime/types';

const createLog = () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  info: jest.fn(),
  report: jest.fn(),
});

const installConstants = () => {
  (global as any).FIND_STRUCTURES = 1;
  (global as any).FIND_SOURCES = 2;
  (global as any).FIND_MINERALS = 3;
  (global as any).STRUCTURE_SPAWN = 'spawn';
  (global as any).STRUCTURE_STORAGE = 'storage';
  (global as any)._ = require('lodash');
};

const createHarness = (forceReInit = false, cacheLeaseTicks = 5000) => {
  let structures: any[] = [];
  let hasVision = true;
  let currentTick = 1;
  const objects = new Map<string, any>();
  const listeners = new Map<string, (data: any) => void>();
  const log = createLog();
  const room = {
    find: jest.fn((type: number) => {
      if (type === FIND_STRUCTURES) return structures;
      return [];
    }),
  } as unknown as Room;
  const bus = {
    subscribe: jest.fn(
      (
        _scope: unknown,
        eventType: string,
        _subscriber: string,
        listener: any
      ) => listeners.set(eventType, listener)
    ),
    unsubscribe: jest.fn(),
    publish: jest.fn(),
  };
  const context = {
    bus,
    env: {
      getGame: jest.fn(() => ({ time: currentTick }) as Game),
      getRoom: jest.fn(() => (hasVision ? room : undefined)),
      getObjectById: jest.fn((id: string) => objects.get(id) ?? null),
      log,
    },
    profiler: null,
    forceReInit,
    cacheLeaseTicks,
  } as unknown as ModuleContext & {
    forceReInit: boolean;
    cacheLeaseTicks: number;
  };

  return {
    shortcuts: createRoomShortcuts(context),
    room,
    bus,
    listeners,
    log,
    setStructures(value: any[]) {
      structures = value;
      for (const object of value) objects.set(object.id, object);
    },
    addObject(object: any) {
      objects.set(object.id, object);
    },
    removeObject(id: string) {
      objects.delete(id);
    },
    setVision(value: boolean) {
      hasVision = value;
    },
    setTick(value: number) {
      currentTick = value;
    },
  };
};

describe('RoomShortcuts', () => {
  beforeEach(() => {
    installConstants();
  });

  it('returns an empty array for collections and undefined for single objects', () => {
    const { shortcuts, log } = createHarness();

    expect(shortcuts.getSpawn('W1N1')).toEqual([]);
    expect(shortcuts.getStorage('W1N1')).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('removes a destroyed structure without rebuilding the room cache', () => {
    const harness = createHarness();
    const first = {
      id: 'spawn-1',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    const second = {
      id: 'spawn-2',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    harness.setStructures([first, second]);

    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([first, second]);
    harness.setStructures([second]);
    harness.removeObject(first.id);
    harness.addObject({
      id: 'ruin-1',
      pos: { roomName: 'W1N1' },
      structure: first,
    });
    harness.listeners.get('structure:destroyed')!({
      roomName: 'W1N1',
      structureId: first.id,
      ruinId: 'ruin-1',
    });

    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([second]);
    expect(harness.room.find).toHaveBeenCalledTimes(3);
    expect(harness.bus.subscribe).toHaveBeenCalledTimes(2);
  });

  it('invalidates the room when the structure and ruin IDs do not match', () => {
    const harness = createHarness();
    const first = {
      id: 'spawn-1',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    const second = {
      id: 'spawn-2',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    harness.setStructures([first]);
    harness.shortcuts.getSpawn('W1N1');

    harness.setStructures([second]);
    harness.addObject({
      id: 'ruin-1',
      pos: { roomName: 'W1N1' },
      structure: second,
    });
    harness.listeners.get('structure:destroyed')!({
      roomName: 'W1N1',
      structureId: first.id,
      ruinId: 'ruin-1',
    });

    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([second]);
    expect(harness.room.find).toHaveBeenCalledTimes(6);
    expect(harness.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('does not match ruin')
    );
  });

  it('invalidates cached room data when vision is lost', () => {
    const harness = createHarness();
    const first = {
      id: 'spawn-1',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    const second = {
      id: 'spawn-2',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    harness.setStructures([first]);
    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([first]);

    harness.setVision(false);
    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([]);

    harness.setStructures([second]);
    harness.setVision(true);
    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([second]);
    expect(harness.room.find).toHaveBeenCalledTimes(6);
  });

  it('filters stale IDs from collections and returns undefined for a stale single object', () => {
    const harness = createHarness();
    const spawn = {
      id: 'spawn-1',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    const storage = {
      id: 'storage-1',
      structureType: STRUCTURE_STORAGE,
      pos: { roomName: 'W1N1' },
    };
    harness.setStructures([spawn, storage]);

    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([spawn]);
    expect(harness.shortcuts.getStorage('W1N1')).toBe(storage);

    harness.removeObject(spawn.id);
    harness.removeObject(storage.id);

    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([]);
    expect(harness.shortcuts.getStorage('W1N1')).toBeUndefined();
  });

  it('reinitializes on every getter when forceReInit is enabled', () => {
    const harness = createHarness(true);
    const spawn = {
      id: 'spawn-1',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    harness.setStructures([spawn]);

    harness.shortcuts.getSpawn('W1N1');
    harness.shortcuts.getSpawn('W1N1');

    expect(harness.room.find).toHaveBeenCalledTimes(6);
    expect(harness.bus.subscribe).toHaveBeenCalledTimes(2);
  });

  it('subscribes to structure events globally once when the module is created', () => {
    const harness = createHarness();

    expect(harness.bus.subscribe).toHaveBeenCalledTimes(2);
    expect(harness.bus.subscribe).toHaveBeenNthCalledWith(
      1,
      { scope: 'global' },
      'structure:built',
      'roomShortcuts',
      expect.any(Function)
    );
    expect(harness.bus.subscribe).toHaveBeenNthCalledWith(
      2,
      { scope: 'global' },
      'structure:destroyed',
      'roomShortcuts',
      expect.any(Function)
    );

    harness.shortcuts.getSpawn('W1N1');
    harness.shortcuts.getSpawn('W2N2');
    expect(harness.bus.subscribe).toHaveBeenCalledTimes(2);
  });

  it('routes a global structure event to the room named in its payload', () => {
    const harness = createHarness();
    const first = {
      id: 'spawn-w1-first',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    const second = {
      id: 'spawn-w2',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W2N2' },
    };
    const built = {
      id: 'spawn-w1-built',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };

    harness.setStructures([first]);
    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([first]);
    harness.setStructures([second]);
    expect(harness.shortcuts.getSpawn('W2N2')).toEqual([second]);

    harness.addObject(built);
    harness.listeners.get('structure:built')!({
      roomName: 'W1N1',
      structureId: built.id,
    });

    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([first, built]);
    expect(harness.shortcuts.getSpawn('W2N2')).toEqual([second]);
  });

  it('refreshes a room after its cache lease expires', () => {
    const harness = createHarness(false, 5000);
    const first = {
      id: 'spawn-1',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    const second = {
      id: 'spawn-2',
      structureType: STRUCTURE_SPAWN,
      pos: { roomName: 'W1N1' },
    };
    harness.setStructures([first]);
    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([first]);

    harness.setStructures([second]);
    harness.setTick(5000);
    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([first]);
    expect(harness.room.find).toHaveBeenCalledTimes(3);

    harness.setTick(5001);
    expect(harness.shortcuts.getSpawn('W1N1')).toEqual([second]);
    expect(harness.room.find).toHaveBeenCalledTimes(6);
  });
});
