/**
 * 文件摘要：验证房间查询快捷方式（@/modules/roomShortcuts）的缓存与失效策略。
 *
 * 覆盖模块：createRoomShortcuts 及其依赖的 ModuleContext 协议（bus/env/profiler 注入）。
 * 覆盖边界：集合查询返回空数组、单体查询返回 undefined；structure:destroyed 命中缓存时
 * 局部删除而不重建房间索引，structureId 与 ruin 记录不一致时保守地丢弃整房缓存；失去
 * 视野（getRoom 返回 undefined）后必须失效并在恢复视野时重建；缓存中的实体被销毁后要
 * 过滤失效 id；缓存租约按 Game.time 到期；forceReInit 时每次查询都重建；事件订阅只在
 * 模块创建时登记一次。
 *
 * 替代实现：Screeps 常量（FIND_* 与 STRUCTURE_*）及 lodash 全局在 Node 下不存在，由
 * beforeEach 手工注入；harness 用 fake room/bus/env 替代真实游戏对象，用 Map 模拟
 * getObjectById 的「对象可能已消失」语义，用闭包中的 tick 驱动租约判定。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不需要 .secret.json，
 * 不执行构建与网络请求。
 */
import { createRoomShortcuts } from '@/modules/roomShortcuts/createRoomShortcuts';
import type { ModuleContext } from '@/contracts';

const createLog = () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  info: jest.fn(),
  report: jest.fn(),
});

/**
 * Screeps 运行时才注入 FIND_* 与 STRUCTURE_* 常量以及 lodash 全局，Node 下必须补齐，
 * 否则模块执行查询时会因未定义全局而失败。这些常量在模块加载后才被读取，
 * 因此放在 beforeEach 注入即可。
 */
const installConstants = () => {
  (global as any).FIND_STRUCTURES = 1;
  (global as any).FIND_SOURCES = 2;
  (global as any).FIND_MINERALS = 3;
  (global as any).STRUCTURE_SPAWN = 'spawn';
  (global as any).STRUCTURE_STORAGE = 'storage';
  (global as any)._ = require('lodash');
};

/**
 * 构造最小 ModuleContext 与可观测的外部世界：
 * - room.find 只响应 FIND_STRUCTURES，find 的调用次数即缓存重建次数，是各用例的核心断言；
 * - env.getGame 返回的 time 可由 setTick 调整，从而无需真实 tick 即可测试缓存租约边界；
 * - objects 是 id → 对象映射，removeObject 用来模拟实体被销毁后 getObjectById 返回 null；
 * - bus 把订阅回调收进 listeners，测试可以直接派发 structure:built/destroyed 事件。
 */
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

  /** 「查不到」不是异常：集合返回空数组、单体返回 undefined，并且不应刷告警日志。 */
  it('returns an empty array for collections and undefined for single objects', () => {
    const { shortcuts, log } = createHarness();

    expect(shortcuts.getSpawn('W1N1')).toEqual([]);
    expect(shortcuts.getStorage('W1N1')).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  /**
   * find 调用次数是关键断言：事件处理应在缓存中局部删除被毁对象，而不是整房重建。
   * subscribe 次数用于确认订阅只在模块创建时登记一次，不会随查询或事件累积。
   */
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

  /** 事件中的 structureId 与 ruin 记录不一致时说明缓存已与游戏状态脱节，此时必须保守地丢弃整房缓存，而不是删错条目。 */
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

  /** 失去视野时 getRoom 返回 undefined：继续返回缓存会给出过期引用，因此必须失效，并在视野恢复后重新 find。 */
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

  /** 缓存命中的 id 仍可能已被销毁（getObjectById 返回 null）：集合里过滤掉，单体查询降级为 undefined。 */
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

  /** forceReInit 是排查缓存问题的开关：开启后每次 getter 都重建，等价于放弃缓存收益，必须仍返回正确结果。 */
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

  /** 订阅按模块实例登记而不是按房间登记：否则查询过的房间越多，重复订阅越多，事件也会被重复处理。 */
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

  /** 事件作用域是 global，必须按 payload.roomName 路由：只失效事件涉及的房间，其他房间的缓存不受影响。 */
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

  /** 租约按 Game.time 判定：边界 tick（5000）仍算有效，超过之后才允许重建，用来固定比较符的边界语义。 */
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
