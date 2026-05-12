import { createBus } from '@/core/eventBus';

describe('EventBus', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should subscribe and publish global events', () => {
    const bus = createBus();
    const mockListener = jest.fn();
    const event = 'creep:spawn';
    const data = { creepName: 'testCreep' };

    bus.subscribe({ scope: 'global' }, event, 'testSubscriber', mockListener);
    bus.publish({ scope: 'global' }, event, data);

    expect(mockListener).toHaveBeenCalledTimes(1);
    expect(mockListener).toHaveBeenCalledWith(data);
  });

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

    bus.publish({ scope: 'room', roomName: 'W1N1' }, event, data);

    expect(globalListener).toHaveBeenCalledWith(data);
    expect(roomListener).toHaveBeenCalledWith(data);
    expect(otherRoomListener).not.toHaveBeenCalled();
  });

  it('should publish global events only to global subscribers', () => {
    const bus = createBus();
    const globalListener = jest.fn();
    const roomListener = jest.fn();
    const event = 'structure:destroyed';
    const data = { structureId: 'sid1' as Id<Structure> };

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

    expect(() =>
      bus.publish({ scope: 'room', roomName: 'NO_ROOM' }, event, data)
    ).not.toThrow();
  });

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
});
