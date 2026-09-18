/**
 * 文件摘要
 *
 * 模块角色：core/eventBus 的事件名称表，为调用方提供可复用的事件字符串。
 *
 * 主要功能：导出分类名 eventCategory 和完整事件名 eventList，减少发布、订阅时手写名称的错误。
 *
 * 实现过程：先定义分类名，再以模板字符串拼接“分类:事件”；satisfies 根据 contracts 的 EventType
 * 检查所有事件值是否合法，并保留各属性的精确字面量类型。
 *
 * 技术要点：as const 提供编译期只读约束，不会在运行时冻结对象。常量在模块加载时建立，
 * 不记录订阅、没有过期状态；新增事件须同步维护 contracts/events 的目录。
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
