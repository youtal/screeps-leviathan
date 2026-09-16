/**
 * 文件摘要：导出 ErrorMapper 工厂并转导其公共契约。
 *
 * 模块位置：core/errorMapper 的公共入口。Runtime 是具体工厂的唯一生产装配者；
 * Framework 和其他消费者只依赖 contracts 中的 ErrorMapper 协议。
 * 本文件不创建实例、不读取 Game 或 Memory，也不产生运行时副作用。
 */
export { createErrorMapper } from './createErrorMapper';
export type * from '@/contracts/errorMapper';
