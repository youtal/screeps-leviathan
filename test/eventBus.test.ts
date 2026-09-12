/**
 * 文件摘要：验证内存事件总线（@/core/eventBus 的 createBus）的作用域路由与容错行为。
 *
 * 覆盖模块：src/core/eventBus/createBus.ts。覆盖边界：global/room/group 三种作用域的
 * 投递范围（room 事件同时投给本房间与 global 订阅者，group 事件不外泄给 global）、
 * 按三元组取消订阅、无订阅者时返回 0 且不打日志、重名订阅覆盖旧监听器并告警、
 * 单个监听器抛错不影响其他监听器、发布期使用监听器快照（回调内的订阅变更只对下一次
 * 发布生效）。
 *
 * 替代实现：总线状态全部保存在工厂闭包内，用例无需 Screeps 全局对象；仅通过
 * jest.fn 监听器与 console.log spy（内核 Logger 的默认输出通道）观察调用与日志，
 * afterEach 统一恢复 spy。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不需要 .secret.json，
 * 不执行构建与网络请求。
 */
import { createBus } from '@/core/eventBus';

describe('EventBus', () => {
  afterEach(() => {
    // 用例会 spy console.log，统一恢复以免日志断言跨用例互相污染。
    jest.restoreAllMocks();
  });

  it('should subscribe and publish global events', () => {
    const bus = createBus();
    const mockListener = jest.fn();
    const event = 'creep:spawn';
    const data = { creepName: 'testCreep' };

    bus.subscribe({ scope: 'global' }, event, 'testSubscriber', mockListener);
    const notified = bus.publish({ scope: 'global' }, event, data);

    expect(notified).toBe(1);
    expect(mockListener).toHaveBeenCalledTimes(1);
    expect(mockListener).toHaveBeenCalledWith(data);
  });

  /** 同时挂 global、本房间与其他房间三个订阅，才能区分「广播」与「误投递到无关作用域」。 */
  it('should publish room events to room and global subscribers', () => {
    const bus = createBus();
    const globalListener = jest.fn();
    const roomListener = jest.fn();
    const otherRoomListener = jest.fn();
    const event = 'resource:transfer';
    const data = {
      resourceType: 'energy' as ResourceConstant,
      amount: 100,
      from: 'id1' as Id<ObjectWithStore>,
      to: 'id2' as Id<ObjectWithStore>,
    };

    bus.subscribe({ scope: 'global' }, event, 'globalSub', globalListener);
    bus.subscribe(
      { scope: 'room', roomName: 'W1N1' },
      event,
      'roomSub',
      roomListener
    );
    bus.subscribe(
      { scope: 'room', roomName: 'W2N2' },
      event,
      'otherRoomSub',
      otherRoomListener
    );

    const notified = bus.publish(
      { scope: 'room', roomName: 'W1N1' },
      event,
      data
    );

    expect(notified).toBe(2);
    expect(globalListener).toHaveBeenCalledWith(data);
    expect(roomListener).toHaveBeenCalledWith(data);
    expect(otherRoomListener).not.toHaveBeenCalled();
  });

  it('should publish global events only to global subscribers', () => {
    const bus = createBus();
    const globalListener = jest.fn();
    const roomListener = jest.fn();
    const event = 'structure:destroyed';
    const data = {
      roomName: 'W1N1',
      structureId: 'sid1' as Id<Structure>,
      ruinId: 'rid1' as Id<Ruin>,
    };

    bus.subscribe({ scope: 'global' }, event, 'globalSub', globalListener);
    bus.subscribe(
      { scope: 'room', roomName: 'W1N1' },
      event,
      'roomSub',
      roomListener
    );
    bus.publish({ scope: 'global' }, event, data);

    expect(globalListener).toHaveBeenCalledWith(data);
    expect(roomListener).not.toHaveBeenCalled();
  });

  /** group 与 global 是并列作用域而非包含关系：group 事件只投给同组订阅者，global 订阅者不应收到。 */
  it('should publish group events only to matching group subscribers', () => {
    const bus = createBus();
    const groupListener = jest.fn();
    const otherGroupListener = jest.fn();
    const globalListener = jest.fn();
    const event = 'combat:started';
    const data = { roomName: 'W1N1', warType: 'raid' as const };

    bus.subscribe({ scope: 'global' }, event, 'globalSub', globalListener);
    bus.subscribe(
      { scope: 'group', groupId: 'squad-alpha' },
      event,
      'groupSub',
      groupListener
    );
    bus.subscribe(
      { scope: 'group', groupId: 'squad-beta' },
      event,
      'otherGroupSub',
      otherGroupListener
    );

    bus.publish({ scope: 'group', groupId: 'squad-alpha' }, event, data);

    expect(groupListener).toHaveBeenCalledWith(data);
    expect(otherGroupListener).not.toHaveBeenCalled();
    expect(globalListener).not.toHaveBeenCalled();
  });

  /** 取消订阅按「作用域 + 事件 + 订阅者名」三元组定位；两个用例分别覆盖 global 与 room 作用域。 */
  it('should unsubscribe from global events', () => {
    const bus = createBus();
    const mockListener = jest.fn();
    const event = 'creep:spawn';
    const data = { creepName: 'abc' };

    bus.subscribe({ scope: 'global' }, event, 'sub', mockListener);
    bus.unsubscribe({ scope: 'global' }, event, 'sub');
    bus.publish({ scope: 'global' }, event, data);

    expect(mockListener).not.toHaveBeenCalled();
  });

  it('should unsubscribe from room-specific events', () => {
    const bus = createBus();
    const mockListener = jest.fn();
    const event = 'resource:transfer';
    const data = {
      resourceType: 'energy' as ResourceConstant,
      amount: 50,
      from: 'id3' as Id<ObjectWithStore>,
      to: 'id4' as Id<ObjectWithStore>,
    };
    const scope = { scope: 'room', roomName: 'W1N2' } as const;

    bus.subscribe(scope, event, 'roomSub', mockListener);
    bus.unsubscribe(scope, event, 'roomSub');
    bus.publish(scope, event, data);

    expect(mockListener).not.toHaveBeenCalled();
  });

  it('should handle publishing to an event with no subscribers', () => {
    const bus = createBus();
    const event = 'combat:ended';
    const data = { roomName: 'W3N3', warType: 'defense' as const };

    expect(
      bus.publish({ scope: 'room', roomName: 'NO_ROOM' }, event, data)
    ).toBe(0);
  });

  it('should not log when an event has no subscribers', () => {
    const bus = createBus();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    expect(
      bus.publish({ scope: 'global' }, 'creep:spawn', {
        creepName: 'NobodyListens',
      })
    ).toBe(0);

    expect(logSpy).not.toHaveBeenCalled();
  });

  /** 重名订阅会覆盖旧监听器：静默覆盖会让排错困难，因此既要有日志，也要确认实际生效的是新监听器。 */
  it('should warn when overwriting a subscriber', () => {
    const bus = createBus();
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    const event = 'creep:spawn';
    const data = { creepName: 'dupCreep' };

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    bus.subscribe({ scope: 'global' }, event, 'dupSub', listener1);
    bus.subscribe({ scope: 'global' }, event, 'dupSub', listener2);

    const matched = logSpy.mock.calls.some((c) =>
      c.join(' ').includes('already has subscriber')
    );
    expect(matched).toBe(true);

    bus.publish({ scope: 'global' }, event, data);
    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalledWith(data);
  });

  /** 观测方（业务监听器）抛错不得中断本轮其他监听器，也不得让发布方抛出，错误只记录到日志。 */
  it('should continue notifying other subscribers if one throws', () => {
    const bus = createBus();
    const event = 'creep:death';
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const data = { creepName: 'rip' };

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    bus.subscribe({ scope: 'global' }, event, 'bad', bad);
    bus.subscribe({ scope: 'global' }, event, 'good', good);

    expect(() => bus.publish({ scope: 'global' }, event, data)).not.toThrow();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalledWith(data);

    const errorLogged = logSpy.mock.calls.some((c) =>
      c.join(' ').includes('error in subscriber bad')
    );
    expect(errorLogged).toBe(true);
  });

  /**
   * 发布时先取监听器快照再依次调用（room 快照先于 global），因此回调内的
   * unsubscribe/subscribe 只影响下一次发布：同一轮通知既不会漏发也不会重发。
   */
  it('should snapshot room and global listeners before invoking either scope', () => {
    const bus = createBus();
    const calls: string[] = [];
    const event = 'creep:spawn';
    const scope = { scope: 'room', roomName: 'W1N1' } as const;

    bus.subscribe({ scope: 'global' }, event, 'oldGlobal', () => {
      calls.push('oldGlobal');
    });
    bus.subscribe(scope, event, 'room', () => {
      calls.push('room');
      bus.unsubscribe({ scope: 'global' }, event, 'oldGlobal');
      bus.subscribe({ scope: 'global' }, event, 'newGlobal', () => {
        calls.push('newGlobal');
      });
    });

    expect(bus.publish(scope, event, { creepName: 'SnapshotTest' })).toBe(2);
    expect(calls).toEqual(['room', 'oldGlobal']);

    calls.length = 0;
    expect(bus.publish(scope, event, { creepName: 'NextPublish' })).toBe(2);
    expect(calls).toEqual(['room', 'newGlobal']);
  });
});
