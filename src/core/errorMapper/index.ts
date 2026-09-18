/**
 * 文件摘要
 *
 * 模块角色：core/errorMapper 的公共入口，向 Runtime 暴露错误处理工厂。
 *
 * 主要功能：导出 createErrorMapper 和错误捕获、执行结果等公共类型。
 *
 * 实现过程：具名转发实现文件中的工厂，使用类型导出转发 contracts/errorMapper 的协议。
 *
 * 技术要点：本文件不创建映射器，不加载 source map，也不保存堆栈缓存；这些工作由工厂实例负责。
 * 同级消费者通过契约接收实例，生产装配由 Runtime 完成。
 */
export { createErrorMapper } from './createErrorMapper';
export type * from '@/contracts/errorMapper';
