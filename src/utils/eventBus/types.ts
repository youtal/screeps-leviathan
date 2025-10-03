import { eventCategory, eventList } from './constants';
import { createBus } from './createBus';

interface EventDataMap {
  [eventCategory.Resource]: {
    resourceType: ResourceConstant;
    amount: number;
    from: Id<ObjectWithStore>;
    to: Id<ObjectWithStore>;
  };
  [eventCategory.Creep]: {
    creepName: string;
  };
  [eventCategory.Structure]: {
    structureId: Id<Structure>;
  };
  [eventCategory.Room]: {
    roomName: string;
  };
  [eventCategory.Combat]: {
    roomName: string;
    warType: 'defense' | 'invasion' | 'raid';
  };
}

export type ListenersMap = Map<EventType, Map<string, (data: any) => void>>;

export interface ListenersStore {
  global: ListenersMap;
  rooms: Map<string, ListenersMap>;
}

export type EventType = (typeof eventList)[keyof typeof eventList];

type ExtractBase<T> = T extends `${infer B}:${infer _}` ? B : never;

export type DataByEvent<T extends EventType = EventType> =
  EventDataMap[ExtractBase<T>];

export type Bus = ReturnType<typeof createBus>;
