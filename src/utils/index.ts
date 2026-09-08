/**
 * 文件摘要：作为通用工具层出口，聚合控制台工具和泛型优先队列。
 *
 * 上层模块应从该入口导入稳定公共能力，避免依赖工具目录内部结构。
 */
export * from './console';
export { PriorityQueue } from './priorityQueue';
