/**
 * 文件摘要：集中声明 EventBus 的事件分类与完整事件名常量。
 *
 * 常量值与 types.ts 中的 EventRegistry 保持对应。调用方使用这些常量可以
 * 避免散落字符串；`satisfies` 会在编译期检查值是否合法，同时保留对象自身
 * 的精确字面量类型，不会把所有属性宽化成笼统的 `EventType`。
 */
import type { EventType } from './types';

/** 分类名常量；`as const` 同时锁定属性只读性和字符串字面量类型。 */
const eventCategory = {
  Resource: 'resource',
  Creep: 'creep',
  Structure: 'structure',
  Room: 'room',
  Combat: 'combat',
} as const;

/** 可直接用于 publish/subscribe 的完整事件名常量。 */
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
