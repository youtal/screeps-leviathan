/**
 * 文件摘要：MemoryManager 模块的公共出口：工厂、诊断类型与契约转导。
 *
 * 模块位置：core/memoryManager 的 barrel。Runtime 在装配阶段调用 createMemoryManager
 * 创建唯一实例，Framework 在 tick 边界驱动 begin/end；模块通过 `context.memory`
 * （由 `host.bind(owner)` 绑定）申请分区。
 *
 * 主要能力：createMemoryManager（平台端口可注入的存储实现）与 MemoryManagerStatus
 * 诊断快照；平台端口、命名空间与迁移的细节类型保持模块内部，不对外导出。
 * 本文件不创建实例、不访问 RawMemory，导入它只建立工厂引用。
 */
export { createMemoryManager } from './createMemoryManager';
export type {
  MemoryManager,
  MemoryManagerOptions,
} from './createMemoryManager';
export type { MemoryManagerStatus } from './types';
/** 公共申请/访问协议整体转导：契约只含类型，编译后不留下代码。 */
export type * from '@/contracts/memory';
