import { EventType, DataByEvent, ListenersStore, ListenersMap } from './types';
import { createLog } from '@/utils';

export const createBus = () => {
  const log = createLog('EventBus', {});
  const store: ListenersStore = {
    global: new Map(),
    rooms: new Map(),
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
    } else {
      if (!store.global.has(eventType)) {
        store.global.set(eventType, new Map());
      }
      const eventListeners = store.global.get(eventType)!;
      //如果已经存在同名订阅者，发出警告
      if (eventListeners.has(subscriber)) {
        log.warn(
          `event ${eventType} already has subscriber ${subscriber} in global, subscriber will be overwritten`
        );
      }
      eventListeners.set(subscriber, listener);
    }
  };

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
