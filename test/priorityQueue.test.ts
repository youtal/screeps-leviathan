import { describe, it, expect, beforeEach } from '@jest/globals';
import { PriorityQueue } from '@utils/priorityQueue'; // 修改路径以符合你的项目结构

describe('PriorityQueue', () => {
  let minHeap: PriorityQueue<number>;
  let maxHeap: PriorityQueue<number>;

  beforeEach(() => {
    minHeap = new PriorityQueue([], (a, b) => a < b); // 小根堆
    maxHeap = new PriorityQueue([], (a, b) => a > b); // 大根堆
  });

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

  it('should initialize from array correctly', () => {
    const arr = [4, 2, 7, 1];
    const pq = new PriorityQueue(arr, (a, b) => a < b);
    expect(pq.pop()).toBe(1);
    expect(pq.pop()).toBe(2);
    expect(pq.pop()).toBe(4);
    expect(pq.pop()).toBe(7);
  });

  it('should throw error on invalid comparator', () => {
    expect(() => new PriorityQueue([], null as any)).toThrow('Comparator must be a function');
  })

  it('should use [] in constructor', () => {
    const pq = new PriorityQueue(undefined, (a: number, b: number) => a < b);
    expect(pq.size).toBe(0);
    expect(pq.isEmpty).toBe(true);
  });
});
