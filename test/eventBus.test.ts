import { createBus } from '@utils/eventBus';
import { eventList } from '@utils/eventBus/constants';

describe('EventBus', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should subscribe and publish global events', () => {
    const bus = createBus();
    const mockListener = jest.fn();
    const event = eventList.creepSpawn;
    const data = { creepName: 'testCreep' };

    bus.subscribe(event, 'testSubscriber', mockListener);
    bus.publish(event, data);

    expect(mockListener).toHaveBeenCalledTimes(1);
    expect(mockListener).toHaveBeenCalledWith(data);
  });

  it('should subscribe and publish room-specific events', () => {
    const bus = createBus();
    const mockListener = jest.fn();
    const event = eventList.resourceTransfer;
    const roomName = 'W1N1';
    const data = {
      resourceType: 'energy' as ResourceConstant,
      amount: 100,
      from: 'id1' as Id<ObjectWithStore>,
      to: 'id2' as Id<ObjectWithStore>,
    };

    bus.subscribe(event, 'roomSub', mockListener, roomName);
    bus.publish(event, data, roomName);

    expect(mockListener).toHaveBeenCalledTimes(1);
    expect(mockListener).toHaveBeenCalledWith(data);
  });

  it('should not notify global listeners for room-specific events', () => {
    const bus = createBus();
    const globalListener = jest.fn();
    const roomListener = jest.fn();
    const event = eventList.structureDestroyed;
    const roomName = 'W1N1';
    const data = { structureId: 'sid1' as Id<Structure> };

    bus.subscribe(event, 'globalSub', globalListener);
    bus.subscribe(event, 'roomSub', roomListener, roomName);
    bus.publish(event, data, roomName);

    expect(globalListener).not.toHaveBeenCalled();
    expect(roomListener).toHaveBeenCalledWith(data);
  });

  it('should unsubscribe from global events', () => {
    const bus = createBus();
    const mockListener = jest.fn();
    const event = eventList.creepSpawn;
    const data = { creepName: 'abc' };

    bus.subscribe(event, 'sub', mockListener);
    bus.unsubscribe(event, 'sub');
    bus.publish(event, data);

    expect(mockListener).not.toHaveBeenCalled();
  });

  it('should unsubscribe from room-specific events', () => {
    const bus = createBus();
    const mockListener = jest.fn();
    const event = eventList.resourceTransfer;
    const roomName = 'W1N2';
    const data = {
      resourceType: 'energy' as ResourceConstant,
      amount: 50,
      from: 'id3' as Id<ObjectWithStore>,
      to: 'id4' as Id<ObjectWithStore>,
    };

    bus.subscribe(event, 'roomSub', mockListener, roomName);
    bus.unsubscribe(event, 'roomSub', roomName);
    bus.publish(event, data, roomName);

    expect(mockListener).not.toHaveBeenCalled();
  });

  it('should handle publishing to an event with no subscribers (global)', () => {
    const bus = createBus();
    const event = eventList.combatStarted;
    const data = { roomName: 'W2N2', warType: 'invasion' as const };
    expect(() => bus.publish(event, data)).not.toThrow();
  });

  it('should handle publishing to an event with no subscribers (room)', () => {
    const bus = createBus();
    const event = eventList.combatEnded;
    const data = { roomName: 'W3N3', warType: 'defense' as const };
    expect(() => bus.publish(event, data, 'NO_ROOM')).not.toThrow();
  });

  it('should warn (log) when overwriting a subscriber (global)', () => {
    const bus = createBus();
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    const event = eventList.creepSpawn;
    const data = { creepName: 'dupCreep' };

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    bus.subscribe(event, 'dupSub', listener1);
    bus.subscribe(event, 'dupSub', listener2); // overwrite

    // 查找包含 already has subscriber 的日志
    const matched = logSpy.mock.calls.some((c) =>
      c.join(' ').includes('already has subscriber')
    );
    expect(matched).toBe(true);

    bus.publish(event, data);
    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalledWith(data);
  });

  it('should continue notifying other subscribers if one throws', () => {
    const bus = createBus();
    const event = eventList.creepDeath;
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const data = { creepName: 'rip' };

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    bus.subscribe(event, 'bad', bad);
    bus.subscribe(event, 'good', good);

    expect(() => bus.publish(event, data)).not.toThrow();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalledWith(data);

    const errorLogged = logSpy.mock.calls.some((c) =>
      c.join(' ').includes('error in subscriber bad')
    );
    expect(errorLogged).toBe(true);
  });
});
