const ConfigWorker: CreepConfig<RoleWorker> = {
  keepSpawn: (mem) => true,
  prepare: (creep) => StageWork,
  charge: (creep) => StageWork,
  work: (creep) => StageWork,
  body: () => [WORK, CARRY, MOVE],
};
