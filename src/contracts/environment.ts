/**
 * 文件摘要
 *
 * 模块角色：contracts 中的游戏环境协议，让业务模块通过注入的环境访问 Screeps。
 *
 * 主要功能：声明 Game、房间、旗帜、两类 creep 与 ID 查询方法，以及日志和可选函数计时能力。
 *
 * 实现过程：EnvMethods 汇集这些方法，EnvContext 再将其作为 env 字段交给模块使用。
 *
 * 技术要点：getObjectById 沿用 Screeps 的泛型签名，保留 ID 与结果类型的对应关系；
 * profiler 仅要求最小的 HasWrap 能力。文件只有类型，不缓存 Game，也不执行查询。
 */
import type { Logger } from './logging';
import type { HasWrap } from './profiler';
/**
 * 模块访问 Screeps 运行时的统一适配层。
 *
 * 它把全局对象 Game 的访问收敛为一组可替换的方法，并附带模块级 log。
 * 这样模块在测试时可以注入假环境，在运行时则访问真实 Screeps API。
 *
 * log 由 createEnvMethods 按模块名创建，因此不同模块可以拥有不同日志前缀。
 *
 * 字段说明：
 * - getObjectById 直接引用 `typeof Game.getObjectById`，保留 Screeps 类型声明
 *   中的泛型签名，调用方不需要再断言返回类型。
 * - log 遵循独立 Logger 契约，不依赖日志工厂推导。
 * - profiler 是可选的包裹能力：Profiler 可能被禁用或创建失败，而且
 *   createEnvMethods 不填充它，运行时实例挂在 ModuleContext.profiler 上。
 */
export interface EnvMethods {
  getGame: () => Game;
  getRoom: (roomName: string) => Room | undefined;
  getFlag: (flagName: string) => Flag | undefined;
  getCreep: (creepName: string) => Creep | undefined;
  getPowerCreep: (powerCreepName: string) => PowerCreep | undefined;
  getObjectById: typeof Game.getObjectById;
  log: Logger;
  profiler?: HasWrap;
}

/**
 * 表示一个模块需要 env 依赖。
 *
 * 业务模块通常不会直接依赖完整 runtime，而是声明自己需要 ModuleContext
 * 或 EnvContext。这样模块可以保持可复用，不知道上下文来自 app 层还是测试。
 */
export interface EnvContext {
  env: EnvMethods;
}
