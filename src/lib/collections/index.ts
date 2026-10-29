/**
 * 文件摘要：lib.collections 的公共出口：泛型优先队列、分桶队列与 LRU 缓存（设计见 docs/design/lib/collections.md，架构设计 4.5）。
 *
 * 所属位置：src/lib/collections/，lib 层，任何层都可以直接导入。
 * 三者都是无继承的扁平 class（架构 12.1 对大量实例的写法），由使用方创建并持有；本模块没有模块级实例或可变状态。
 */
export { BucketQueue } from './bucketQueue';
export { LruCache } from './lru';
export { PriorityQueue } from './priorityQueue';
export type { Comparator } from './priorityQueue';
