/**
 * 文件摘要
 *
 * 模块角色：core/logger 的公共入口，供 Runtime 取得日志工厂和调用方引用日志类型。
 *
 * 主要功能：导出 createLogging，以及 Logger、LoggerFactory、配置与输出接口等公共协议。
 *
 * 实现过程：转发 createLogging.ts 的具名工厂，并以类型导出转发 contracts/logging。
 *
 * 技术要点：入口不创建默认日志实例，不输出消息或访问 Game；配置与前缀缓存由工厂及其作用域持有。
 * Core 同级模块接收注入的 LoggerFactory，不通过此入口取得隐藏的共享实例。
 */
export { createLogging } from './createLogging';

/**
 * 公共协议整体转导：契约只含类型，编译后不留下代码，新增日志类型无需在此登记。
 */
export type * from '@/contracts/logging';
