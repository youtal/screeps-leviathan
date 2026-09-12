/**
 * 文件摘要：集中声明 EventBus 的事件分类与完整事件名常量。
 *
 * core/eventBus 的协议数据层：分类名与事件名的拼接规则必须与 types.ts 中
 * EventType 的 `${category}:${eventName}` 模板保持一致；这些常量导出的目的
 * 就是让 publish/subscribe 不再各处手写字符串，避免拼写漂移。
 *
 * 输入/输出：本文件不含函数与参数，只导出两个只读常量对象 —— eventCategory
 * 提供分类名，eventList 在其基础上拼出可直接使用的事件名。
 *
 * 状态与副作用：全部值在模块加载时求值一次，之后只读，不占用 Memory，也不随
 * global reset 改变。`satisfies` 会在编译期检查值是否合法，同时保留对象自身的
 * 精确字面量类型，不会把所有属性宽化成笼统的 `EventType`。
 *
 * 维护顺序：先在 contracts/events 的 EventRegistry 注册分类与事件，再补这里的常量；
 * 反过来 satisfies 会直接报编译错误，避免出现无法被 publish 使用的事件名。
 */
import type { EventType } from '@/contracts';

/**
 * 分类名常量。
 *
 * `as const` 同时锁定属性只读性和字符串字面量类型，让
 * `${eventCategory.Resource}` 推导出字面量而不是 string，从而能参与 EventType
 * 的模板拼接；同时避免运行时被误改。
 */
const eventCategory = {
  Resource: 'resource',
  Creep: 'creep',
  Structure: 'structure',
  Room: 'room',
  Combat: 'combat',
} as const;

/**
 * 可直接用于 publish/subscribe 的完整事件名常量。
 *
 * 用模板字符串而不是逐个手写 `'resource:low'`，是为了让「分类 + 事件」的协议
 * 只存在一处：分类名调整时所有事件名同步变化，也不会出现把 `resource:low`
 * 写成 `resourceLow` 之类的拼写偏差。
 *
 * `satisfies Record<string, EventType>` 只约束值必须属于 EventType 联合，键名
 * 仍保留业务侧命名（如 resourceLow），因此未在 EventRegistry 注册的事件名会在
 * 编译期失败。
 */
const eventList = {
  resourceLow: `${eventCategory.Resource}:low`,
  resourceTransfer: `${eventCategory.Resource}:transfer`,
  resourceHarvest: `${eventCategory.Resource}:harvest`,
  creepSpawn: `${eventCategory.Creep}:spawn`,
  creepDeath: `${eventCategory.Creep}:death`,
  structureBuilt: `${eventCategory.Structure}:built`,
  structureDamaged: `${eventCategory.Structure}:damaged`,
  structureDestroyed: `${eventCategory.Structure}:destroyed`,
  roomClaimed: `${eventCategory.Room}:claimed`,
  roomScouted: `${eventCategory.Room}:scouted`,
  roomLevelUp: `${eventCategory.Room}:levelUp`,
  roomLevelDown: `${eventCategory.Room}:levelDown`,
  roomLost: `${eventCategory.Room}:lost`,
  combatStarted: `${eventCategory.Combat}:started`,
  combatEnded: `${eventCategory.Combat}:ended`,
  combatVictory: `${eventCategory.Combat}:victory`,
  combatDefeat: `${eventCategory.Combat}:defeat`,
} as const satisfies Record<string, EventType>;

export { eventCategory, eventList };
