const eventCategory = {
  Resource: 'resource',
  Creep: 'creep',
  Structure: 'structure',
  Room: 'room',
  Combat: 'combat',
} as const;

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
} as const;

declare global {
  let EventList: typeof eventList;
}

export { eventCategory, eventList };
