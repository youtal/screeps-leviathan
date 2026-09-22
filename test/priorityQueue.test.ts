/**
 * 文件摘要：验证 @utils/priorityQueue 泛型二叉堆队列的对外行为。
 *
 * 覆盖模块：src/utils/priorityQueue.ts 的 PriorityQueue。覆盖边界：排序方向完全
 * 由调用方比较器决定（小根/大根）、乱序插入后按优先级出队、peek 只读、size 与
 * isEmpty、clear 后仍可安全 pop、用已有数组批量初始化、非法比较器在构造期抛错、
 * 省略数组参数时按空队列处理。
 *
 * 替代实现：纯数据结构，不依赖任何 Screeps 全局对象、mock、vm 或临时目录；
 * 测试原语从 @jest/globals 显式导入，不依赖 jest 的全局注入。
 *
 * 运行方式：npm test（jest --runInBand，testEnvironment=node）；不需要
 * .secret.json，不执行构建与网络请求。
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PriorityQueue } from '@utils/priorityQueue'; // 修改路径以符合你的项目结构

describe('PriorityQueue', () => {
  let minHeap: PriorityQueue<number>;
  let maxHeap: PriorityQueue<number>;

  /**
   * 比较器语义是「pre 的优先级高于 nxt」，因此 a < b 得到小根堆、a > b 得到大根堆。
   * 两个实例共用同一批断言数据，可排除实现内部硬编码排序方向的可能。
   */
  beforeEach(() => {
    minHeap = new PriorityQueue<number>([], (a, b) => a < b); // 小根堆
    maxHeap = new PriorityQueue<number>([], (a, b) => a > b); // 大根堆
  });

  /** 乱序插入后按优先级出队，验证的是堆序而非插入顺序；空队列 pop 返回 undefined 与 Array.pop 语义一致。 */
  it('should push and pop elements in min-heap order', () => {
    minHeap.push(5);
    minHeap.push(3);
    minHeap.push(8);
    minHeap.push(1);
    expect(minHeap.pop()).toBe(1);
    expect(minHeap.pop()).toBe(3);
    expect(minHeap.pop()).toBe(5);
    expect(minHeap.pop()).toBe(8);
    expect(minHeap.pop()).toBeUndefined(); // 空队列
  });

  it('should push and pop elements in max-heap order', () => {
    maxHeap.push(5);
    maxHeap.push(3);
    maxHeap.push(8);
    maxHeap.push(1);
    expect(maxHeap.pop()).toBe(8);
    expect(maxHeap.pop()).toBe(5);
    expect(maxHeap.pop()).toBe(3);
    expect(maxHeap.pop()).toBe(1);
    expect(maxHeap.pop()).toBeUndefined(); // 空队列
  });

  it('should peek correctly', () => {
    minHeap.push(10);
    minHeap.push(2);
    minHeap.push(5);
    expect(minHeap.peek).toBe(2); // 最小元素
    minHeap.pop();
    expect(minHeap.peek).toBe(5);
  });

  it('should return correct size and isEmpty', () => {
    expect(minHeap.isEmpty).toBe(true);
    expect(minHeap.size).toBe(0);
    minHeap.push(1);
    expect(minHeap.isEmpty).toBe(false);
    expect(minHeap.size).toBe(1);
  });

  it('should clear all elements', () => {
    minHeap.push(1);
    minHeap.push(2);
    minHeap.clear();
    expect(minHeap.size).toBe(0);
    expect(minHeap.isEmpty).toBe(true);
    expect(minHeap.pop()).toBeUndefined(); // 清空后pop应返回undefined
  });

  /** 构造函数拷贝传入数组并用 Floyd 建堆整理（O(n)），所以这里验证「未排序数组也有序出队」这条批量初始化路径。 */
  it('should initialize from array correctly', () => {
    const arr = [4, 2, 7, 1];
    const pq = new PriorityQueue(arr, (a, b) => a < b);
    expect(pq.pop()).toBe(1);
    expect(pq.pop()).toBe(2);
    expect(pq.pop()).toBe(4);
    expect(pq.pop()).toBe(7);
  });

  /** F5：队列拥有自己的存储，构造与后续操作都不改写调用方数组。 */
  it('should not mutate the caller array', () => {
    const arr = [5, 3, 9, 1];
    const pq = new PriorityQueue(arr, (a, b) => a < b);
    pq.push(0);
    pq.pop();
    pq.clear();
    expect(arr).toEqual([5, 3, 9, 1]);
  });

  /** 比较器是维持堆序的必要依赖，构造期即抛错可避免把非法配置推迟到首次 push/pop 才暴露。 */
  it('should throw error on invalid comparator', () => {
    expect(() => new PriorityQueue([], null as any)).toThrow(
      'Comparator must be a function'
    );
  });

  /** 允许显式传 undefined，兼容调用方按条件传数组的写法（内部回退为空数组而不是抛错）。 */
  it('should use [] in constructor', () => {
    const pq = new PriorityQueue(undefined, (a: number, b: number) => a < b);
    expect(pq.size).toBe(0);
    expect(pq.isEmpty).toBe(true);
  });
});
