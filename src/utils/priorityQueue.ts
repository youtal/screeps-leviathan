/**
 * 文件摘要：实现由调用方比较器决定优先级的泛型二叉堆队列。
 *
 * 数组下标 `i` 的子节点为 `2i+1`、`2i+2`，父节点为 `floor((i-1)/2)`；push
 * 和 pop 通过局部上浮/下沉保持堆序，时间复杂度 O(log n)，peek 为 O(1)。
 * 队列直接复用构造参数数组以减少复制，调用方不应再并行修改该数组。
 */
export class PriorityQueue<T> {
  /** 紧凑数组形式的二叉堆；下标 0 始终保存当前最高优先级元素。 */
  private readonly heap: T[] = [];
  /** 返回 true 表示 pre 的优先级高于 nxt；具体排序方向由调用方定义。 */
  private readonly comparator: (pre: T, nxt: T) => boolean;

  private swap(index1: number, index2: number): void {
    /** 解构赋值在不创建显式临时变量的情况下交换两个堆节点。 */
    [this.heap[index1], this.heap[index2]] = [
      this.heap[index2],
      this.heap[index1],
    ];
  }

  private shiftUp(index: number): void {
    /** 新节点持续与父节点比较，直至到达根或已满足堆序。 */
    if (index === 0) return;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.comparator(this.heap[index], this.heap[parentIndex])) {
        this.swap(index, parentIndex);
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  private shiftDown(index: number): void {
    /** 根节点替换后持续选择优先级最高的子节点交换，以恢复整棵堆。 */
    const length = this.heap.length;
    while (index < length) {
      const leftChildIndex = index * 2 + 1;
      const rightChildIndex = index * 2 + 2;
      let nxtIndex = index;

      if (
        leftChildIndex < length &&
        this.comparator(this.heap[leftChildIndex], this.heap[nxtIndex])
      ) {
        nxtIndex = leftChildIndex;
      }
      if (
        rightChildIndex < length &&
        this.comparator(this.heap[rightChildIndex], this.heap[nxtIndex])
      ) {
        nxtIndex = rightChildIndex;
      }
      if (nxtIndex !== index) {
        this.swap(index, nxtIndex);
        index = nxtIndex;
      } else {
        break;
      }
    }
  }

  private heapify(): void {
    /**
     * 自最后一个非叶节点向根执行下沉，使用 Floyd 建堆法在 O(n) 内整理数组。
     */
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.shiftDown(i);
    }
  }

  constructor(arr: T[], comparator: (pre: T, nxt: T) => boolean) {
    /** 比较器是维持堆序的必要依赖，构造阶段提前拒绝无效值。 */
    if (typeof comparator !== 'function') {
      throw new Error('Comparator must be a function');
    }
    this.heap = arr || [];
    this.comparator = comparator;
    this.heapify();
  }

  public push(item: T): void {
    /** 先追加到数组末尾，再上浮新节点恢复堆序。 */
    this.heap.push(item);
    this.shiftUp(this.heap.length - 1);
  }

  public pop(): T | undefined {
    /**
     * 将根与末尾交换后弹出最高优先级元素，再从根下沉替代节点。
     * 空队列返回 undefined，与原生 Array.pop 的语义一致。
     */
    if (this.heap.length === 0) return undefined;
    this.swap(0, this.heap.length - 1);
    const poppedItem = this.heap.pop()!;
    this.shiftDown(0);
    return poppedItem;
  }

  public clear(): void {
    /** 原地截断数组，保留内部引用并释放所有元素引用。 */
    this.heap.length = 0;
  }

  get size(): number {
    /** 当前元素数量，直接读取数组 length，复杂度 O(1)。 */
    return this.heap.length;
  }

  get isEmpty(): boolean {
    /** 空状态的语义化只读属性。 */
    return this.heap.length === 0;
  }

  get peek(): T | undefined {
    /** 只读最高优先级元素而不修改堆；空队列返回 undefined。 */
    return this.heap[0];
  }
}
