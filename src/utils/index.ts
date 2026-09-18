/**
 * 文件摘要
 *
 * 模块角色：utils 的统一入口，汇集可被不同模块复用的格式化工具和数据结构。
 *
 * 主要功能：导出控制台文本工具与 PriorityQueue 泛型优先队列。
 *
 * 实现过程：转发 console 的公共导出，并具名转发 priorityQueue.ts 中的队列类。
 *
 * 技术要点：本文件不创建队列或输出文本，状态由具体工具的调用方或实例持有。
 * 导出范围由下面两条语句决定；日志工厂属于 core/logger，不在此创建或提供默认实例。
 */
export * from './console';
export { PriorityQueue } from './priorityQueue';
