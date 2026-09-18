/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的公共入口，向 Runtime 提供管理器工厂并发布访问类型。
 *
 * 主要功能：导出 createMemoryManager、创建选项、管理器与诊断类型，以及公共分区申请协议。
 *
 * 实现过程：从主实现转发工厂和配置，从内部类型文件转发状态，从 contracts/memory 转发访问约定。
 *
 * 技术要点：入口不创建管理器或读取存储；Raw 格式处理和 Segment 平台操作不在此公开。
 * 实例由 Runtime 组装，Framework 驱动 begin/end，业务通过绑定的 memory 入口申请分区。
 */
export { createMemoryManager } from './createMemoryManager';
export type {
  MemoryManager,
  MemoryManagerOptions,
} from './createMemoryManager';
export type { MemoryManagerStatus } from './types';
/** 公共申请/访问协议整体转导：契约只含类型，编译后不留下代码。 */
export type * from '@/contracts/memory';
