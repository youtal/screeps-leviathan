/**
 * 文件摘要：把 Screeps 全局对象包装成可注入的环境方法，并为模块创建独立日志器。
 *
 * core/runtime 的适配层：业务模块依赖 EnvMethods 而不是直接散布全局访问，
 * 便于单元测试替换运行环境，运行时仍访问真实 Screeps API。
 *
 * 输入是模块名（同时作为日志前缀）、可选的 LogOptions 以及是否让错误日志额外
 * 调用 Game.notify；输出是 EnvMethods —— 一组无状态的 Game 访问闭包，加上按
 * 模块创建的 log。
 *
 * 状态与副作用：Game 查询函数是模块级共享常量，只在调用时读取全局 Game，
 * 不缓存任何 Game 对象，因此跨 tick 不会持有失效引用；唯一状态是 createLog
 * 持有的日志配置。global reset 后模块重新求值，行为保持一致。
 */
import { createLog } from '@/utils/console';
import type { EnvMethods } from './types';

/**
 * 不随模块变化的 Screeps 运行时访问方法。
 *
 * 方法体刻意等到调用时才读取 `Game`：Screeps 每个 tick 都会重建 Game 全局，
 * 模块加载阶段也可能早于 Game 就绪（例如单元测试注入之前），提前捕获会拿到
 * 旧对象或直接抛错。
 *
 * 抽成共享常量是为了让 createEnvMethods 每次只生成不同的 log，而不重复定义
 * Game 访问方法。类型写成 `Omit<EnvMethods, 'log'>`：EnvMethods 新增 Game
 * 访问方法时这里会直接编译失败，避免接口与实现漂移；`profiler` 在 EnvMethods
 * 中声明为可选，所以该对象不需要提供它。
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
 * opt 用于覆盖默认日志开关；notify 控制错误日志是否同步调用 Game.notify
 * （notify 会发送邮件且受频率限制，createLog 以 60 分钟为分组间隔调用它，
 * 因此这里默认关闭）。
 *
 * 每次调用都返回新对象：spread 复制共享的 Game 访问方法，再挂上专属 log，
 * 模块之间不会互相覆盖日志配置。返回值不含 profiler —— Profiler 由
 * createRuntime 作为 ModuleContext 的字段单独挂载。
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
