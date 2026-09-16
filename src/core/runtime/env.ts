/**
 * 文件摘要：把 Screeps 全局对象包装成可注入的环境方法，并为模块派生作用域日志器。
 *
 * core/runtime 的适配层：业务模块依赖 EnvMethods 而不是直接散布全局访问，
 * 便于单元测试替换运行环境，运行时仍访问真实 Screeps API。
 *
 * 输入是模块名（同时作为日志前缀）、可选的 LogOptions、是否允许该模块发送错误邮件，
 * 以及 Runtime 组装的 LoggerFactory；输出是 EnvMethods —— 一组无状态的 Game 访问
 * 闭包，加上按模块作用域派生的 log。日志等级与输出端口全部由注入的工厂决定，
 * 本文件不再持有日志实现，因此 core 不再反向依赖 utils/console 的日志代码。
 *
 * 状态与副作用：Game 查询函数只在调用时执行注入的 getGame，
 * 不缓存任何 Game 对象，因此跨 tick 不会持有失效引用；唯一状态来自注入的
 * 日志工厂（由装配方持有）。global reset 后模块重新求值，行为保持一致。
 */
import type { LoggerFactory, LogOptions } from '@/contracts/logging';
import type { EnvMethods } from '@/contracts';

/**
 * 不随模块变化的 Screeps 运行时访问方法。
 *
 * 方法体刻意等到调用时才读取 `Game`：Screeps 每个 tick 都会重建 Game 全局，
 * 模块加载阶段也可能早于 Game 就绪（例如单元测试注入之前），提前捕获会拿到
 * 旧对象或直接抛错。
 *
 * 工厂集中生成访问方法，使测试与生产使用同一组惰性查询语义。返回类型写成
 * `Omit<EnvMethods, 'log'>`：EnvMethods 新增 Game
 * 访问方法时这里会直接编译失败，避免接口与实现漂移；`profiler` 在 EnvMethods
 * 中声明为可选，所以该对象不需要提供它。
 */
const createGameMethods = (getGame: () => Game): Omit<EnvMethods, 'log'> => ({
  getGame,
  getRoom: (roomName: string) => getGame().rooms[roomName],
  getFlag: (flagName: string) => getGame().flags[flagName],
  getCreep: (creepName: string) => getGame().creeps[creepName],
  getPowerCreep: (powerCreepName: string) =>
    getGame().powerCreeps[powerCreepName],
  getObjectById: (id: Id<_HasId>) => getGame().getObjectById(id),
});

/**
 * 创建模块级运行环境。
 *
 * moduleName 会成为日志前缀，例如 `RoomShortcuts` 或 `Profiler`。
 * opt 逐字段覆盖日志等级；notify 是该作用域对装配级邮件策略的覆盖——undefined
 * 跟随装配策略（默认 off），显式 false 强制关闭，true 在装配允许时开启错误邮件。
 * 邮件会发送且受频率限制，分组间隔由装配方的 notifyInterval 决定（默认 60 分钟）。
 *
 * logging 必须由 Runtime 显式提供，让所有模块共用端口与策略；环境适配器不会
 * 导入 Logger 具体实现或创建隐藏实例。
 * 每次调用都返回新对象：生成 Game 访问方法后再挂上专属 log，
 * 模块之间不会互相覆盖日志配置。返回值不含 profiler —— Profiler 由
 * createRuntime 作为 ModuleContext 的字段单独挂载。
 */
export const createEnvMethods = (
  moduleName: string,
  logging: LoggerFactory,
  opt: LogOptions = {},
  notify?: boolean,
  getGame: () => Game = () => Game
): EnvMethods => {
  return {
    ...createGameMethods(getGame),
    log: logging.scope(moduleName, { levels: opt, notify }),
  };
};
