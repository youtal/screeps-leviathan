/**
 * 文件摘要
 *
 * 模块角色：contracts 的服务令牌协议，供能力提供者与 Framework 插件使用者共享服务名和类型。
 *
 * 主要功能：defineService 在模块装载时创建只含 name 的令牌；ServiceToken<T> 让
 * services.get(token) 推断服务接口，并让 services.provide(token, value) 检查提供值的类型。
 *
 * 技术要点：unique symbol 属性只存在于类型空间，不进入运行时对象或 Memory；Framework
 * 仍用 name 查表并按提供者插件 id 检查依赖。令牌不携带提供者身份，也不验证运行时载荷，
 * 因此它不会改变 manifest.requires/provides 的语义或服务生命周期。
 */

/** 不导出符号值，避免调用方依赖类型标记的运行时存在。 */
declare const SERVICE_TYPE: unique symbol;

/** 将服务名与返回类型关联；运行时对象只有 name。 */
export interface ServiceToken<T> {
  readonly name: string;
  readonly [SERVICE_TYPE]?: T;
}

/** 令牌在模块装载时创建一次，重复读取不分配新对象。 */
export const defineService = <T>(name: string): ServiceToken<T> => ({ name });
