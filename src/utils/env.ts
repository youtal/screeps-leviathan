import {
  dyeGreen,
  dyeYellow,
  dyeBlue,
  dyeCyan,
  dyeMagenta,
  dyeOrange,
  dyeRed,
  dyeViolet,
  createLog,
} from './console';
import { EnvMethods, EnvContext } from './types';

const staticMethods: Omit<EnvMethods, 'log'> = {
  getGame: () => Game,
  getRoom: (roomName: string) => Game.rooms[roomName],
  getFlag: (flagName: string) => Game.flags[flagName],
  getCreep: (creepName: string) => Game.creeps[creepName],
  getPowerCreep: (powerCreepName: string) => Game.powerCreeps[powerCreepName],
  getObjectById: Game.getObjectById,
  dye: {
    green: dyeGreen,
    yellow: dyeYellow,
    blue: dyeBlue,
    cyan: dyeCyan,
    magenta: dyeMagenta,
    orange: dyeOrange,
    red: dyeRed,
    violet: dyeViolet,
  },
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
