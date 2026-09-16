/**
 * 文件摘要：Logger 内核模块的公共出口：装配工厂与契约类型转导。
 *
 * 模块位置：core/logger 的 barrel。Runtime 在装配阶段调用 createLogging 创建
 * 唯一工厂，再注入模块环境与内核消费者；同级模块不会从这里取得默认单例。
 *
 * 主要能力：createLogging（装配级工厂，遵守 `src/contracts/logging.ts` 的
 * LoggerFactory 协议）。本文件不定义日志行为、不访问 Game/Memory，也不在模块
 * 求值阶段创建任何实例。
 */
export { createLogging } from './createLogging';

/**
 * 公共协议整体转导：契约只含类型，编译后不留下代码，新增日志类型无需在此登记。
 */
export type * from '@/contracts/logging';
