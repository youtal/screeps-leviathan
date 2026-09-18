/**
 * 文件摘要
 *
 * 模块角色：core/eventBus 的消息分发实现，由 Runtime 创建并注入各模块。
 *
 * 主要功能：按作用域和事件名管理订阅、取消订阅、同步通知，并返回尝试通知的监听器数量。
 *
 * 实现过程：嵌套 Map 按房间或分组、事件名、订阅者名索引回调；同键订阅替换旧回调，
 * 取消后清理空索引。发布前取得快照，room 同时通知该房间与 global，group 则只通知本组。
 *
 * 技术要点：本轮快照不受回调中增删订阅的影响，监听器异常被隔离并通过注入的日志器记录。
 * 索引只保存在实例内存中，可跨 tick 复用；global reset 后需重新订阅，不产生存储序列化成本。
 */
import type {
  Bus,
  DataByEvent,
  EventScope,
  EventType,
  LoggerFactory,
} from '@/contracts';
import { ListenersMap, ListenersStore } from './types';

/**
 * 对外订阅时使用的强类型监听器。
 *
 * createBus 内部会把不同事件的 listener 存进同一个 Map，因此存储边界
 * 只能退化为 `(data: unknown) => void`。这个类型别名用于保证对外 API
 * 仍然保持 `EventType -> DataByEvent<EventType>` 的精确对应关系。
 */
type Listener<T extends EventType> = (data: DataByEvent<T>) => void;
/** `[订阅者名称, 回调]` 数组；数组顺序继承 Map 的插入顺序。 */
type ListenerSnapshot = [string, (data: unknown) => void][];

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

/**
 * 工厂本身只创建闭包状态，不订阅、不发布，也不访问 Game 或 Memory：
 * 订阅表随实例驻留 heap，global reset 后由装配方（Runtime 或 Framework）重新创建。
 *
 * logging 由装配方显式注入，使总线的诊断日志与模块日志共用同一套等级、端口和
 * 邮件策略。EventBus 不导入同级 Logger 实现，也不在缺少依赖时创建隐藏实例。
 */
export const createBus = (logging: LoggerFactory): Bus => {
  /**
   * 总线日志使用 EventBus 作用域与装配方配置的等级（info 默认关闭），正常运行
   * 时不会被订阅/发布明细刷屏；排错时由装配方打开对应等级即可观察调用链。
   */
  const log = logging.scope('EventBus');

  /**
   * 运行时监听器仓库。
   *
   * global 是单个 ListenersMap；room 和 group 会按 roomName/groupId
   * 再分一层 Map。这样可以让不同 room/group 的同名事件彼此隔离。
   *
   * 仓库随闭包存在，不进入 Memory：订阅者的函数无法序列化，也没有跨 tick
   * 持久化的意义；空容器会由 deleteEmptyScope 及时回收，避免长期运行时堆积。
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

    /**
     * 同一个作用域下，一个 subscriber 只保留一个回调：重复订阅会被覆盖并记录
     * warn，让“以为注册了两份逻辑、实际只剩一份”的问题能立刻暴露。
     *
     * 存储层的值类型是 `(data: unknown) => void`，这里的断言把强类型 Listener<T>
     * 擦除为存储层的通用签名；类型正确性由 subscribe 的泛型参数 T 保证，运行时
     * 不做校验。
     */
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
     *
     * 删除后若事件级 Map 已空，会继续回收空容器；这条清理链让长期运行的
     * heap 占用只与“当前有效订阅数”相关，而与历史上出现过的房间/分组数量无关。
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

  const createSnapshot = (
    scope: EventScope,
    eventType: EventType
  ): ListenerSnapshot | undefined => {
    /**
     * `Array.from` 复制当前条目，避免回调执行期间的 subscribe/unsubscribe
     * 改变本轮遍历集合。没有监听器时返回 undefined，供发布路径快速退出。
     *
     * 复制成本与监听器数量线性相关（O(n) 时间与一次数组分配），且只在确有订阅者
     * 时发生；快照只在本轮 publish 内有效，用完即被 GC 回收，不跨 tick 保留。
     */
    const eventListeners = getScopedListeners(scope)?.get(eventType);
    return eventListeners?.size
      ? Array.from(eventListeners.entries())
      : undefined;
  };

  const notify = <T extends EventType>(
    scope: EventScope,
    eventType: T,
    data: DataByEvent<T>,
    snapshot: ListenerSnapshot | undefined
  ): number => {
    /**
     * notify 是单个作用域内的底层派发函数。
     *
     * 它不理解广播规则，只负责：
     * - 接收 publish 在任何回调执行前取得的订阅者快照。
     * - 逐个调用 listener，并隔离 listener 抛出的异常。
     *
     * 广播规则由 publish 负责组合 notify 调用。
     *
     * 监听器同步执行，因此调用的 CPU 成本直接计入当前 tick；异常只记录 error
     * 日志而不向上抛出，避免某个订阅者出错中断整轮派发或影响发布方的业务逻辑，
     * 代价是发布方无法感知订阅者失败。
     * 返回值是快照长度，即本轮尝试调用的监听器数量，包含执行中抛错的那些。
     */
    if (!snapshot) return 0;

    const label = scopeLabel(scope);
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
  ): number => {
    /**
     * 当前广播原则：
     * - global publish：只通知 global 订阅者。
     * - room publish：通知当前 room 订阅者，并上报给 global 订阅者。
     * - group publish：只通知同 group 订阅者。
     *
     * group 不自动上报 global，是为了让任务组、编队等内部消息保持隔离，
     * 避免污染全局事件流。
     * 返回值是各次 notify 计数之和，即本轮尝试通知的监听器数量（含执行中抛错
     * 的那些）；无订阅时直接返回 0，不生成日志。
     *
     * room 分支先取好两份快照再派发：room 回调里新增/取消的订阅即使命中
     * global 作用域，也不会改变本轮 global 的调用集合。globalScope 只是为了让
     * getScopedListeners/notify 复用同一套作用域接口而临时构造的判别对象，
     * global 分支会直接返回 store.global，不产生 Map 查找。
     */
    if (scope.scope === 'room') {
      const roomSnapshot = createSnapshot(scope, eventType);
      const globalScope = { scope: 'global' } as const;
      const globalSnapshot = createSnapshot(globalScope, eventType);

      return (
        notify(scope, eventType, data, roomSnapshot) +
        notify(globalScope, eventType, data, globalSnapshot)
      );
    }

    return notify(scope, eventType, data, createSnapshot(scope, eventType));
  };

  /**
   * 只暴露这三个方法，store 与日志组件都被闭包封装，外部无法绕过作用域规则
   * 直接篡改订阅表；同一实例应被所有模块复用，才能保证事件互通。
   */
  return {
    subscribe,
    unsubscribe,
    publish,
  };
};
