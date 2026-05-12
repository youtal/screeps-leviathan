import { createLog } from '@/utils/console';
import type { EnvMethods } from './types';

/**
 * 不随模块变化的 Screeps 运行时访问方法。
 *
 * 这些方法只是薄薄包一层 Game 全局对象。它们被抽出来复用，是为了让
 * createEnvMethods 每次只生成不同的 log，而不重复定义 Game 访问方法。
 */
const staticMethods: Omit<EnvMethods, 'log'> = {
  getGame: () => Game,
  getRoom: (roomName: string) => Game.rooms[roomName],
  getFlag: (flagName: string) => Game.flags[flagName],
  getCreep: (creepName: string) => Game.creeps[creepName],
  getPowerCreep: (powerCreepName: string) => Game.powerCreeps[powerCreepName],
  getObjectById: (id: Id<_HasId>) => Game.getObjectById(id),
};

/**
 * 创建模块级运行环境。
 *
 * moduleName 会成为日志前缀，例如 `RoomShortcuts` 或 `Profiler`。
 * opt 用于覆盖默认日志开关；notify 控制错误日志是否同步调用 Game.notify。
 *
 * 返回的 EnvMethods 不持有状态。它只提供访问真实 Screeps runtime 的方法
 * 和一个带模块名前缀的 log 对象，因此可以安全地为每个模块派生一份。
 */
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
