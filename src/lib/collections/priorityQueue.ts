/**
 * 文件摘要：lib.collections 的泛型优先队列（二叉堆），设计见 docs/design/lib/collections.md。
 *
 * 所属位置：src/lib/collections/，由 index.ts 导出。供 spawnQueue 按"优先级、deadline"出队、寻路预算按优先级分配等使用。
 * 语义：比较函数与 Array.prototype.sort 的约定相同，compare(a, b) < 0 表示 a 先出队；相等元素的出队顺序不保证稳定，
 * 需要稳定时由调用方在比较函数中加入次序键（例如入队序号）。
 * 复杂度：push、pop 为 O(log n)，peek 为 O(1)，from 以自底向上建堆为 O(n)。
 * 状态：实例持有一个数组，pop 时缩短数组，不保留已出队元素的引用；clear 只把长度置 0，数组本身可复用。
 */

/**
 * 比较函数：返回负数表示 a 应先于 b 出队，0 表示相等，正数表示 b 先。
 * @template T 元素类型。
 */
export type Comparator<T> = (a: T, b: T) => number;

/**
 * 泛型二叉堆优先队列。
 * @template T 元素类型，可以是任意值；队列不复制、不修改元素。
 */
export class PriorityQueue<T> {
  /** 堆数组：下标 i 的子节点为 2i + 1 与 2i + 2，heap[0] 为下一个出队的元素。 */
  private readonly heap: T[];
  /** 创建时传入的比较函数。 */
  private readonly compare: Comparator<T>;

  /**
   * @description 创建空队列。
   * @param compare 比较函数，compare(a, b) < 0 表示 a 先出队。
   * @example
   * const q = new PriorityQueue<Request>((a, b) => b.priority - a.priority || a.deadline - b.deadline);
   */
  constructor(compare: Comparator<T>) {
    this.heap = [];
    this.compare = compare;
  }

  /**
   * @description 以一组元素一次建堆，比逐个 push 少一个对数因子。
   * @template T 元素类型。
   * @param items 初始元素；只读取一次，不保留对该可迭代对象的引用。
   * @param compare 比较函数。
   * @returns 新队列。
   */
  static from<T>(items: Iterable<T>, compare: Comparator<T>): PriorityQueue<T> {
    const queue = new PriorityQueue<T>(compare);
    for (const item of items) queue.heap.push(item);
    for (let i = (queue.heap.length >> 1) - 1; i >= 0; i -= 1) queue.siftDown(i);
    return queue;
  }

  /**
   * @description 当前元素个数。
   * @returns 元素个数。
   */
  get size(): number {
    return this.heap.length;
  }

  /**
   * @description 入队。
   * @param item 元素。
   * @returns 无返回值；修改队列。
   */
  push(item: T): void {
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  /**
   * @description 取出最先的元素。
   * @returns 该元素；队列为空时为 undefined。
   */
  pop(): T | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    // 先取出末尾元素再缩短数组，数组中不残留已出队元素的引用。
    const last = heap.pop() as T;
    if (heap.length > 0) {
      heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /**
   * @description 查看最先的元素而不取出。
   * @returns 该元素；队列为空时为 undefined。
   */
  peek(): T | undefined {
    return this.heap.length > 0 ? this.heap[0] : undefined;
  }

  /**
   * @description 清空队列，保留内部数组以便复用。
   * @returns 无返回值；释放全部元素引用。
   */
  clear(): void {
    this.heap.length = 0;
  }

  /**
   * @description 把下标 i 的元素向上移动到满足堆序的位置。
   * @param i 下标。
   * @returns 无返回值；修改堆数组。
   */
  private siftUp(i: number): void {
    const heap = this.heap;
    const item = heap[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(item, heap[parent]) >= 0) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = item;
  }

  /**
   * @description 把下标 i 的元素向下移动到满足堆序的位置。
   * @param i 下标。
   * @returns 无返回值；修改堆数组。
   */
  private siftDown(i: number): void {
    const heap = this.heap;
    const n = heap.length;
    const item = heap[i];
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && this.compare(heap[child + 1], heap[child]) < 0) child += 1;
      if (this.compare(heap[child], item) >= 0) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = item;
  }
}
