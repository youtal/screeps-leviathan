import { EventType, DataByEvent, ListenersStore, ListenersMap } from './types';
import { createLog } from '@/utils';
import {MAX_GROUP_EVENTBUS_TTL} from '@/setting';

export const createBus = () => {
  const log = createLog('EventBus', {});
  const store: ListenersStore = {
    global: new Map(),
    rooms: new Map(),
    group: new Map(),
  };

  const subscribe = <T extends EventType>(
    eventType: T,
    subscriber: string,
    listener: (data: DataByEvent<T>) => void,
    roomName?: string
  ) => {
    if (roomName !== undefined) {
      if (!store.rooms.has(roomName)) {
        store.rooms.set(roomName, new Map());
      }
      const roomListeners = store.rooms.get(roomName)!;
      if (!roomListeners.has(eventType)) {
        roomListeners.set(eventType, new Map());
      }
      //如果已经存在同名订阅者，发出警告
      if (roomListeners.get(eventType)!.has(subscriber)) {
        log.warn(
          `event ${eventType} already has subscriber ${subscriber} in room ${roomName}, subscriber will be overwritten`
        );
      }
      roomListeners.get(eventType)!.set(subscriber, listener);
    }
  };

  const subscribeByGlobal = <T extends EventType>(
    eventType: T,
    subscriber: string,
    listener: (data: DataByEvent<T>) => void
  ) => {
    if (!store.global.has(eventType)) {
      store.global.set(eventType, new Map());
      log.info(`event ${eventType} added to global`);
    }
    const eventListeners = store.global.get(eventType)!;
    //如果已经存在同名订阅者，发出警告
    if (eventListeners.has(subscriber)) {
      log.warn(`event ${eventType} already has subscriber ${subscriber} in global, subscriber will be overwritten`);
    }
    eventListeners.set(subscriber, listener);
    log.info(`subscribe ${subscriber} to event ${eventType} in global`);
  };

  const subscribeByRoom = <T extends EventType>(
    eventType: T,
    subscriber: string,
    listener: (data: DataByEvent<T>) => void,
    roomName: string
  ) => {
    //检查该房间是否已经存在订阅信息，如果不存在则创建
    if (!store.rooms.has(roomName)) {
      store.rooms.set(roomName, new Map());
      log.info(`room ${roomName} added to rooms`);
    }

    //检查该事件类型是否已经存在订阅信息，如果不存在则创建
    const roomListeners = store.rooms.get(roomName)!;
    if (!roomListeners.has(eventType)) {
      roomListeners.set(eventType, new Map());
      log.info(`event ${eventType} added to room ${roomName}`);
    }

    //如果已经存在同名订阅者，发出警告;
    if (roomListeners.get(eventType)!.has(subscriber)) {
      log.warn(
        `event ${eventType} already has subscriber ${subscriber} in room ${roomName}, subscriber will be overwritten`
      );
    }

    //将订阅者添加到订阅列表中
    roomListeners.get(eventType)!.set(subscriber, listener);
    log.info(`subscribe ${subscriber} to event ${eventType} in room ${roomName}`);
  }

  const subscribeByGroup = <T extends EventType>(
    eventType: T,
    subscriber: string,
    listener: (data: DataByEvent<T>) => void,
    groupName: string
  ) => {
    //检查该组是否已经存在订阅信息，如果不存在则创建
    if (!store.group.has(groupName)) {
      store.group.set(groupName, new Map());
      log.info(`group ${groupName} added to group`);
    }

    //检查该事件类型是否已经存在订阅信息，如果不存在则创建
    const groupListeners = store.group.get(groupName)!;
    if (!groupListeners.has(eventType)) {
      groupListeners.set(eventType, new Map());
      log.info(`event ${eventType} added to group ${groupName}`);
    }

    //如果已经存在同名订阅者，发出警告;
    if (groupListeners.get(eventType)!.has(subscriber)) {
      log.warn(
        `event ${eventType} already has subscriber ${subscriber} in group ${groupName}, subscriber will be overwritten`
      );
    }
    
    //将订阅者添加到订阅列表中
    groupListeners.get(eventType)!.set(subscriber, listener);
    log.info(`subscribe ${subscriber} to event ${eventType} in group ${groupName}`);
  }
    

  const unsubscribe = (
    eventType: EventType,
    subscriber: string,
    roomName?: string
  ) => {
    if (roomName !== undefined) {
      //检查是否存在订阅
      if (
        !store.rooms.has(roomName) ||
        !store.rooms.get(roomName)!.has(eventType) ||
        !store.rooms.get(roomName)!.get(eventType)!.has(subscriber)
      ) {
        log.warn(
          `no subscriber ${subscriber} for event ${eventType} in room ${roomName}`
        );
        return;
      }
      store.rooms.get(roomName)!.get(eventType)!.delete(subscriber);
      if (store.rooms.get(roomName)!.get(eventType)!.size === 0) {
        //如果该事件类型的订阅者列表为空，则删除该事件类型
        store.rooms.get(roomName)!.delete(eventType);
        log.info(
          `event ${eventType} has no subscribers, removed from room ${roomName}`
        );
        if (store.rooms.get(roomName)!.size === 0) {
          //如果该房间的订阅者列表为空，则删除该房间
          store.rooms.delete(roomName);
          log.info(`room ${roomName} has no subscribers, removed from rooms`);
        }
      }
      log.info(
        `unsubscribe ${subscriber} from event ${eventType} in room ${roomName}`
      );
    } else {
      //检查是否存在订阅
      if (
        !store.global.has(eventType) ||
        !store.global.get(eventType)!.has(subscriber)
      ) {
        log.warn(
          `no subscriber ${subscriber} for event ${eventType} in global`
        );
        return;
      }
      store.global.get(eventType)!.delete(subscriber);
      if (store.global.get(eventType)!.size === 0) {
        //如果该事件类型的订阅者列表为空，则删除该事件类型
        store.global.delete(eventType);
        log.info(`event ${eventType} has no subscribers, removed from global`);
      }
      log.info(`unsubscribe ${subscriber} from event ${eventType} in global`);
    }
  };

  const publish = <T extends EventType>(
    eventType: T,
    data: DataByEvent<T>,
    roomName?: string
  ) => {
    log.info(
      `publish event ${eventType}, room: ${roomName ? roomName : 'global'}`
    );
    let subscribers: ListenersMap;
    if (roomName !== undefined) subscribers = store.rooms.get(roomName)!;
    else subscribers = store.global;

    //订阅列表为空，则直接返回
    if (!subscribers || !subscribers.has(eventType)) {
      log.warn(
        `no subscribers for event ${eventType} in ${roomName ? `room ${roomName}` : 'global'}`
      );
      return;
    }

    subscribers.get(eventType)!.forEach((listener, subscriber) => {
      log.info(`notifying subscriber ${subscriber} for event ${eventType}`);
      try {
        listener(data);
      } catch (e) {
        log.error(
          `error in subscriber ${subscriber} for event ${eventType}: ${e}`
        );
      }
    });
  };

  return {
    subscribe,
    unsubscribe,
    publish,
  };
};
