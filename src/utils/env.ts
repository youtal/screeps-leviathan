import { createLog } from './console';
import { EnvMethods } from './types';

const staticMethods: Omit<EnvMethods, 'log'> = {
  getGame: () => Game,
  getRoom: (roomName: string) => Game.rooms[roomName],
  getFlag: (flagName: string) => Game.flags[flagName],
  getCreep: (creepName: string) => Game.creeps[creepName],
  getPowerCreep: (powerCreepName: string) => Game.powerCreeps[powerCreepName],
  getObjectById: Game.getObjectById,
};

export const createEnvMethods = (
  moduleName: string,
  opt: LogOptions = {},
  notify: boolean = false
): EnvMethods => {
  return {
    ...staticMethods,
    log: createLog(moduleName, opt, notify),
  };
};
