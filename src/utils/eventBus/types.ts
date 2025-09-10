const EventCategory = {
  Resource: 'resource',
  Creep: 'creep',
  Structure: 'structure',
  Room: 'room',
  Combat: 'combat',
} as const;

type EventCategoryType = (typeof EventCategory)[keyof typeof EventCategory];

type ValidEventType = `${EventCategoryType}:${string}`;

// 事件类型到数据负载的类型映射
interface EventDataMap {
  [EventCategory.Resource]: {
    resourceType: ResourceConstant;
    amount: number;
    from: Id<ObjectWithStore>;
    to: Id<ObjectWithStore>;
    timestamp: number;
  };
  [EventCategory.Creep]: {
    creepName: string;
    timestamp: number;
  };
  [EventCategory.Structure]: {
    structureId: Id<Structure>;
    timestamp: number;
  };
  [EventCategory.Room]: {
    roomName: string;
    timestamp: number;
  };
  [EventCategory.Combat]: {
    roomName: string;
    warType: 'defense' | 'invasion' | 'raid';
    timestamp: number;
  };
}

const EventList: Record<string, ValidEventType> = {
  resourceLow: `${EventCategory.Resource}:low`,
  resourceTransfer: `${EventCategory.Resource}:transfer`,
  resourceHarvest: `${EventCategory.Resource}:harvest`,
  creepSpawn: `${EventCategory.Creep}:spawn`,
  creepDeath: `${EventCategory.Creep}:death`,
  structureBuilt: `${EventCategory.Structure}:built`,
  structureDamaged: `${EventCategory.Structure}:damaged`,
  structureDestroyed: `${EventCategory.Structure}:destroyed`,
  roomClaimed: `${EventCategory.Room}:claimed`,
  roomScouted: `${EventCategory.Room}:scouted`,
  roomLevelUp: `${EventCategory.Room}:levelUp`,
  roomLevelDown: `${EventCategory.Room}:levelDown`,
  roomLost: `${EventCategory.Room}:lost`,
  combatStarted: `${EventCategory.Combat}:started`,
  combatEnded: `${EventCategory.Combat}:ended`,
  combatVictory: `${EventCategory.Combat}:victory`,
  combatDefeat: `${EventCategory.Combat}:defeat`,
} as const;

type EventType = (typeof EventList)[keyof typeof EventList];

type ExtractBase<T> = T extends `${infer B}:${infer _}` ? B : never;

export type DataByEvent<T extends EventType = EventType> =
  EventDataMap[ExtractBase<T>];

// 导出所有需要的类型
export { EventCategory, EventList };
export type {
  EventCategoryType,
  ValidEventType,
  EventDataMap,
  EventType,
  ExtractBase,
};
