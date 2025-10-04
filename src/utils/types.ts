import { createLog } from './console';

export interface EnvMethods {
  getGame: () => Game;
  getRoom: (roomName: string) => Room | undefined;
  getFlag: (flagName: string) => Flag | undefined;
  getCreep: (creepName: string) => Creep | undefined;
  getPowerCreep: (powerCreepName: string) => PowerCreep | undefined;
  getObjectById: typeof Game.getObjectById;
  log: ReturnType<typeof createLog>;
  profiler?: HasWrap;
}

export interface EnvContext {
  env: EnvMethods;
}

export type Wrap = <F extends (...args: any[]) => any>(
  label: string,
  fn: F
) => F;

export interface HasWrap {
  wrap: Wrap;
}
