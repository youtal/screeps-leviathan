/**
 * 文件摘要：保存 EventBus 监听器索引；公共总线和事件协议由 contracts 发布。
 * 仅维护模块内部类型及契约兼容出口，不创建运行时状态或调用宿主。
 */
import type { EventType } from '@/contracts/events';
export type * from '@/contracts/eventBus';
export type * from '@/contracts/events';
/**
 * 监听器存储结构。
 *
 * 第一层 Map：
 * - key 是完整事件名，例如 `creep:spawn`
 * - value 是该事件下的订阅者集合
 *
 * 第二层 Map：
 * - key 是 subscriber 名称，用于覆盖、取消订阅和日志定位
 * - value 是实际监听器函数
 *
 * 这里监听器参数使用 `unknown`，而不是 `DataByEvent<EventType>` 或 `any`：
 * - 对外 API 会在 `subscribe` 时用泛型保证 listener 参数类型正确。
 * - 内部 Map 需要同时存储不同事件的不同 listener，无法在一个 Map 中
 *   精确保留每个 key 与 data 的对应关系。
 * - `unknown` 比 `any` 更保守，可以把“不知道具体类型”的事实限制在内部边界。
 */
export type ListenersMap = Map<EventType, Map<string, (data: unknown) => void>>;

/**
 * EventBus 的全部监听器仓库。
 *
 * 当前支持三种作用域：
 * - global：全局事件，不绑定具体房间或分组。
 * - rooms：按 roomName 隔离的事件集合。
 * - group：按 groupName 隔离的事件集合。
 *
 * 注意：这个类型只描述存储能力。某个作用域是否已经暴露完整的
 * subscribe/publish/unsubscribe API，需要以 `createBus` 的返回值为准。
 *
 * 由 createBus 按此结构建立闭包仓库：global 在创建时初始化且始终存在；
 * rooms/group 按需创建，并在最后一个订阅被移除后回收，避免长期运行时堆积空容器。
 */
export interface ListenersStore {
  global: ListenersMap;
  rooms: Map<string, ListenersMap>;
  group: Map<string, ListenersMap>;
}
