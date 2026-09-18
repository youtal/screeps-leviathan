/**
 * 文件摘要
 *
 * 模块角色：contracts 中的消息传递协议，供发布者、订阅者和总线实现共同使用。
 *
 * 主要功能：规定 global、room、group 三种作用域，以及订阅、取消订阅和同步发布接口。
 *
 * 实现过程：用 scope 判别字段约束房间名或分组名，再用事件名泛型关联监听器参数与发布数据。
 *
 * 技术要点：room 发布通知同房间与 global 订阅者，group 独立；global 发布不遍历房间。
 * publish 返回尝试调用的监听器数量，包含抛错者；本文件不保存订阅或执行回调。
 */
import type { EventType, DataByEvent } from './events';
/**
 * 全局事件作用域。
 *
 * global 作用域不绑定任何 room 或 group，因此只有一个判别字段：
 * `scope: 'global'`。
 *
 * 它用于两类场景：
 * - 发布真正的全局事件，例如系统 tick、全局统计、跨房间调度信号。
 * - 订阅全局观察者。按照当前广播原则，global 订阅者除了接收
 *   global 发布的事件，也会接收 room 发布的同类型事件。
 *
 * 注意：global 发布不会向所有 room 扇出。需要全房间广播时，应由业务层
 * 显式遍历房间并逐个发布 room 事件，避免隐藏的 CPU 成本。
 */
export type GlobalScope = {
  scope: 'global';
};

/**
 * 房间事件作用域。
 *
 * room 作用域要求同时提供：
 * - `scope: 'room'`：作为 TypeScript 判别字段。
 * - `roomName`：指定事件所属房间。
 *
 * 这种结构让调用方无法写出 `{ scope: 'room' }` 这种缺少 roomName
 * 的不完整作用域，也无法把 groupId 错传给 room 作用域。
 *
 * 按照当前广播原则：
 * - room 订阅者只接收同 room 发布的事件。
 * - room 发布会同时通知同 room 订阅者和 global 订阅者。
 * - room 发布不会通知其他 room，也不会通知任何 group。
 */
export type RoomScope = {
  scope: 'room';
  roomName: string;
};

/**
 * 分组事件作用域。
 *
 * group 作用域要求同时提供：
 * - `scope: 'group'`：作为 TypeScript 判别字段。
 * - `groupId`：指定事件所属逻辑分组。
 *
 * group 通常用于任务组、编队、临时流程、跨房间但不应暴露给全局监听流的
 * 逻辑频道。它与 room/global 不存在默认联动。
 *
 * 按照当前广播原则：
 * - group 订阅者只接收同 groupId 发布的事件。
 * - group 发布不会通知 global 订阅者。
 * - group 发布也不会通知任何 room 订阅者。
 */
export type GroupScope = {
  scope: 'group';
  groupId: string;
};

/**
 * EventBus 对外统一使用的作用域描述。
 *
 * 它是一个 discriminated union（判别联合）：
 * - 当 `scope` 是 `'global'` 时，不允许也不需要其他定位字段。
 * - 当 `scope` 是 `'room'` 时，必须携带 `roomName`。
 * - 当 `scope` 是 `'group'` 时，必须携带 `groupId`。
 *
 * 统一作用域参数让 subscribe/publish/unsubscribe 可以共用同一组接口，
 * 同时仍然在类型层面强制不同层级提供正确的定位信息。
 *
 * 示例：
 *
 * ```ts
 * bus.publish({ scope: 'global' }, 'creep:spawn', data);
 * bus.publish({ scope: 'room', roomName: 'W1N1' }, 'resource:low', data);
 * bus.publish({ scope: 'group', groupId: 'squad-alpha' }, 'combat:started', data);
 * ```
 */
export type EventScope = GlobalScope | RoomScope | GroupScope;
/** 事件名泛型关联回调和发布载荷；监听器异常由总线隔离。 */
export type EventListener<T extends EventType> = (data: DataByEvent<T>) => void;
/** 同键订阅替换原监听器；publish 返回尝试调用的监听器数量（包含抛错者），具体广播边界见作用域。 */
export interface Bus {
  subscribe<T extends EventType>(
    scope: EventScope,
    eventType: T,
    subscriber: string,
    listener: EventListener<T>
  ): void;
  unsubscribe(
    scope: EventScope,
    eventType: EventType,
    subscriber: string
  ): void;
  publish<T extends EventType>(
    scope: EventScope,
    eventType: T,
    data: DataByEvent<T>
  ): number;
}
