import {
  DataByEvent,
  EventScope,
  EventType,
  ListenersMap,
  ListenersStore,
} from './types';
import { createLog } from '@/utils/console';

/**
 * 对外订阅时使用的强类型监听器。
 *
 * createBus 内部会把不同事件的 listener 存进同一个 Map，因此存储边界
 * 只能退化为 `(data: unknown) => void`。这个类型别名用于保证对外 API
 * 仍然保持 `EventType -> DataByEvent<EventType>` 的精确对应关系。
 */
type Listener<T extends EventType> = (data: DataByEvent<T>) => void;

/**
 * 将作用域转换为日志中可读的描述。
 *
 * EventScope 是判别联合，switch 中每个分支都会自动收窄：
 * - global 分支只能访问 global scope 字段。
 * - room 分支可以安全访问 roomName。
 * - group 分支可以安全访问 groupId。
 */
const scopeLabel = (scope: EventScope): string => {
  switch (scope.scope) {
    case 'global':
      return 'global';
    case 'room':
      return `room ${scope.roomName}`;
    case 'group':
      return `group ${scope.groupId}`;
  }
};

export const createBus = () => {
  const log = createLog('EventBus', {});

  /**
   * 运行时监听器仓库。
   *
   * global 是单个 ListenersMap；room 和 group 会按 roomName/groupId
   * 再分一层 Map。这样可以让不同 room/group 的同名事件彼此隔离。
   */
  const store: ListenersStore = {
    global: new Map(),
    rooms: new Map(),
    group: new Map(),
  };

  /**
   * 根据作用域获取对应的监听器集合。
   *
   * `createIfMissing` 只在订阅路径中使用：
   * - subscribe 需要在首次订阅某个 room/group 时创建容器。
   * - publish/unsubscribe 只应该读取已有容器，找不到就按无订阅处理。
   *
   * global 容器始终存在，因此不会返回 undefined。
   * room/group 容器可能尚未创建，因此在读取路径中返回 undefined。
   */
  const getScopedListeners = (
    scope: EventScope,
    createIfMissing = false
  ): ListenersMap | undefined => {
    if (scope.scope === 'global') return store.global;

    if (scope.scope === 'room') {
      if (!store.rooms.has(scope.roomName) && createIfMissing) {
        store.rooms.set(scope.roomName, new Map());
        log.info(`room ${scope.roomName} added to rooms`);
      }

      return store.rooms.get(scope.roomName);
    }

    if (!store.group.has(scope.groupId) && createIfMissing) {
      store.group.set(scope.groupId, new Map());
      log.info(`group ${scope.groupId} added to group`);
    }

    return store.group.get(scope.groupId);
  };

  /**
   * 删除已经没有任何事件订阅的 room/group 容器。
   *
   * 事件级 Map 清空后会先删除 eventType；如果该 room/group 下已经没有
   * 其他事件，就继续删除外层容器，避免长期运行时留下空壳。
   *
   * global 容器是总线根存储的一部分，不会被删除。
   */
  const deleteEmptyScope = (scope: EventScope): void => {
    if (scope.scope === 'room' && store.rooms.get(scope.roomName)?.size === 0) {
      store.rooms.delete(scope.roomName);
      log.info(`room ${scope.roomName} has no subscribers, removed from rooms`);
    }

    if (scope.scope === 'group' && store.group.get(scope.groupId)?.size === 0) {
      store.group.delete(scope.groupId);
      log.info(`group ${scope.groupId} has no subscribers, removed from group`);
    }
  };

  const subscribe = <T extends EventType>(
    scope: EventScope,
    eventType: T,
    subscriber: string,
    listener: Listener<T>
  ) => {
    /**
     * 订阅路径会创建缺失的 room/group 容器。
     *
     * 这里的非空断言是安全的：global 一定返回 store.global；
     * room/group 在 createIfMissing 为 true 时会被创建后返回。
     */
    const listeners = getScopedListeners(scope, true)!;
    const label = scopeLabel(scope);

    if (!listeners.has(eventType)) {
      listeners.set(eventType, new Map());
      log.info(`event ${eventType} added to ${label}`);
    }

    const eventListeners = listeners.get(eventType)!;
    if (eventListeners.has(subscriber)) {
      log.warn(
        `event ${eventType} already has subscriber ${subscriber} in ${label}, subscriber will be overwritten`
      );
    }

    eventListeners.set(subscriber, listener as (data: unknown) => void);
    log.info(`subscribe ${subscriber} to event ${eventType} in ${label}`);
  };

  const unsubscribe = (
    scope: EventScope,
    eventType: EventType,
    subscriber: string
  ) => {
    /**
     * 取消订阅不会创建缺失容器。
     *
     * 如果作用域、事件或 subscriber 任意一层不存在，都按“没有这个订阅”
     * 处理并记录 warn。这样 unsubscribe 可以安全地重复调用。
     */
    const listeners = getScopedListeners(scope);
    const label = scopeLabel(scope);
    const eventListeners = listeners?.get(eventType);

    if (!eventListeners?.has(subscriber)) {
      log.warn(
        `no subscriber ${subscriber} for event ${eventType} in ${label}`
      );
      return;
    }

    eventListeners.delete(subscriber);

    if (eventListeners.size === 0) {
      listeners!.delete(eventType);
      log.info(`event ${eventType} has no subscribers, removed from ${label}`);
      deleteEmptyScope(scope);
    }

    log.info(`unsubscribe ${subscriber} from event ${eventType} in ${label}`);
  };

  const notify = <T extends EventType>(
    scope: EventScope,
    eventType: T,
    data: DataByEvent<T>
  ): number => {
    /**
     * notify 是单个作用域内的底层派发函数。
     *
     * 它不理解广播规则，只负责：
     * - 找到指定 scope + eventType 的订阅者。
     * - 对订阅者做快照。
     * - 逐个调用 listener，并隔离 listener 抛出的异常。
     *
     * 广播规则由 publish 负责组合 notify 调用。
     */
    const listeners = getScopedListeners(scope);
    const eventListeners = listeners?.get(eventType);
    const label = scopeLabel(scope);

    if (!eventListeners || eventListeners.size === 0) {
      log.warn(`no subscribers for event ${eventType} in ${label}`);
      return 0;
    }

    /**
     * 派发前做快照，避免 listener 在回调中 subscribe/unsubscribe 时影响
     * 当前这一轮遍历。被修改的订阅关系从下一次 publish 开始生效。
     */
    const snapshot = Array.from(eventListeners.entries());
    snapshot.forEach(([subscriber, listener]) => {
      log.info(`notifying subscriber ${subscriber} for event ${eventType}`);
      try {
        listener(data);
        log.info(
          `subscriber ${subscriber} notified for event ${eventType} in ${label}`
        );
      } catch (e) {
        log.error(
          `error in subscriber ${subscriber} for event ${eventType}: ${e}`
        );
      }
    });

    return snapshot.length;
  };

  const publish = <T extends EventType>(
    scope: EventScope,
    eventType: T,
    data: DataByEvent<T>
  ) => {
    log.info(`publish event ${eventType}, scope: ${scopeLabel(scope)}`);

    /**
     * 当前广播原则：
     * - global publish：只通知 global 订阅者。
     * - room publish：通知当前 room 订阅者，并上报给 global 订阅者。
     * - group publish：只通知同 group 订阅者。
     *
     * group 不自动上报 global，是为了让任务组、编队等内部消息保持隔离，
     * 避免污染全局事件流。
     */
    if (scope.scope === 'room') {
      notify(scope, eventType, data);
      notify({ scope: 'global' }, eventType, data);
      return;
    }

    notify(scope, eventType, data);
  };

  return {
    subscribe,
    unsubscribe,
    publish,
  };
};
