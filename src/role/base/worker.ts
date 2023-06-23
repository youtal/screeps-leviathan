import { CreepConfig, CreepActionStage, RoleWorker } from "../types";

const ConfigWorker: CreepConfig<RoleWorker> = {
  keepSpawn: (mem) => true,
  prepare: (creep) => CreepActionStage.Prepare,
  charge: (creep) => CreepActionStage.Charge,
  work: (creep) => CreepActionStage.Work,
  body: () => [WORK, CARRY, MOVE],
};
