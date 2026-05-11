import type { createBus } from './createBus';

export interface EventRegistry {
  /**
   * Define event contracts by category.
   *
   * categoryData is shared by every event in the category. A concrete event
   * can use {} to inherit it as-is, or declare extra fields. If an extra field
   * has the same key as categoryData, the concrete event type wins.
   */
  resource: {
    categoryData: {
      resourceType: ResourceConstant;
      amount: number;
      from: Id<ObjectWithStore>;
      to?: Id<ObjectWithStore>;
    };
    events: {
      low: {};
      transfer: {};
      harvest: {};
    };
  };
  creep: {
    categoryData: {
      creepName: string;
    };
    events: {
      spawn: {};
      death: {};
    };
  };
  structure: {
    categoryData: {
      structureId: Id<Structure>;
    };
    events: {
      built: {};
      damaged: {};
      destroyed: {
        structureId: Id<Structure> | Id<Ruin>;
      };
    };
  };
  room: {
    categoryData: {
      roomName: string;
    };
    events: {
      claimed: {};
      scouted: {};
      levelUp: {};
      levelDown: {};
      lost: {};
    };
  };
  combat: {
    categoryData: {
      roomName: string;
      warType: 'defense' | 'invasion' | 'raid';
    };
    events: {
      started: {};
      ended: {};
      victory: {};
      defeat: {};
    };
  };
}

type Category = keyof EventRegistry & string;

type EventName<C extends Category> =
  keyof EventRegistry[C]['events'] & string;

export type EventType = {
  [C in Category]: `${C}:${EventName<C>}`;
}[Category];

type SplitEvent<T extends EventType> =
  T extends `${infer C}:${infer E}` ? [C, E] : never;

type CategoryOf<T extends EventType> = SplitEvent<T>[0] & Category;

type NameOf<T extends EventType> = SplitEvent<T>[1];

type CategoryData<T extends EventType> =
  EventRegistry[CategoryOf<T>]['categoryData'];

type EventExtraData<T extends EventType> =
  NameOf<T> extends keyof EventRegistry[CategoryOf<T>]['events']
    ? EventRegistry[CategoryOf<T>]['events'][NameOf<T>]
    : never;

type Merge<Base, Extra> = Omit<Base, keyof Extra> & Extra;

export type DataByEvent<T extends EventType = EventType> = T extends EventType
  ? Merge<CategoryData<T>, EventExtraData<T>>
  : never;

export type ListenersMap = Map<
  EventType,
  Map<string, (data: unknown) => void>
>;

export interface ListenersStore {
  global: ListenersMap;
  rooms: Map<string, ListenersMap>;
  group: Map<string, ListenersMap>;
}

export type Bus = ReturnType<typeof createBus>;
