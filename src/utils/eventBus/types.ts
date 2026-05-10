import { eventList } from './constants';
import { createBus } from './createBus';

type ResourceEventData = {
    resourceType: ResourceConstant;
    amount: number;
    from: Id<ObjectWithStore>;
    to?: Id<ObjectWithStore>;
};

type EventDataMap = {
  [eventList.resourceLow]: ResourceEventData;
  [eventList.resourceTransfer]: ResourceEventData;
  [eventList.resourceHarvest]: ResourceEventData;
  [eventList.creepSpawn]: { creepName: string };
  [eventList.creepDeath]: { creepName: string };
  [eventList.structureBuilt]: { structureId: Id<Structure> };
  [eventList.structureDamaged]: { structureId: Id<Structure> };
  [eventList.structureDestroyed]: { structureId: Id<Structure> | Id<Ruin> };
  [eventList.roomClaimed]: { roomName: string };
  [eventList.roomScouted]: { roomName: string };
  [eventList.roomLevelUp]: { roomName: string };
  [eventList.roomLevelDown]: { roomName: string };
  [eventList.roomLost]: { roomName: string };
  [eventList.combatStarted]: {
    roomName: string;
    warType: 'defense' | 'invasion' | 'raid';
  };
  [eventList.combatEnded]: {
    roomName: string;
    warType: 'defense' | 'invasion' | 'raid';
  };
  [eventList.combatVictory]: {
    roomName: string;
    warType: 'defense' | 'invasion' | 'raid';
  };
  [eventList.combatDefeat]: {
    roomName: string;
    warType: 'defense' | 'invasion' | 'raid';
  };
};

export type ListenersMap = Map<EventType, Map<string, (data: any) => void>>;

export interface ListenersStore {
  global: ListenersMap;
  rooms: Map<string, ListenersMap>;
  group: Map<string, ListenersMap>;
}

export type EventType = (typeof eventList)[keyof typeof eventList];

export type DataByEvent<T extends EventType = EventType> = EventDataMap[T];

export type Bus = ReturnType<typeof createBus>;
