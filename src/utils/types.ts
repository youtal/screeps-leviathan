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

export interface EnvMethods {
  getGame: () => Game;
  getRoom: (roomName: string) => Room | undefined;
  getFlag: (flagName: string) => Flag | undefined;
  getCreep: (creepName: string) => Creep | undefined;
  getPowerCreep: (powerCreepName: string) => PowerCreep | undefined;
  getObjectById: typeof Game.getObjectById;
  log: ReturnType<typeof createLog>;
  dye: {
    green: typeof dyeGreen;
    yellow: typeof dyeYellow;
    blue: typeof dyeBlue;
    cyan: typeof dyeCyan;
    magenta: typeof dyeMagenta;
    orange: typeof dyeOrange;
    red: typeof dyeRed;
    violet: typeof dyeViolet;
  };
}

export interface EnvContext {
  env: EnvMethods;
}
