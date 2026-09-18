/**
 * 文件摘要
 *
 * 模块角色：core/eventBus 的内部索引类型文件，同时保留公共事件协议的类型出口。
 *
 * 主要功能：描述事件到订阅者回调的 ListenersMap，以及 global、rooms、group 三类索引。
 *
 * 实现过程：用嵌套 Map 表达“事件名 → 订阅者名 → 回调”，再按作用域组合成 ListenersStore；
 * 公共作用域与事件数据类型直接从 contracts 转发。
 *
 * 技术要点：内部容器用 unknown 接纳不同事件的回调，事件名与数据的精确对应由公开泛型接口保证。
 * 文件只描述索引形状，不创建 Map；实际索引的增删和清理由 createBus 负责。
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
