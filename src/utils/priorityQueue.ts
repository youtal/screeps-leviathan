export class PriorityQueue<T> {
  private readonly heap: T[] = [];
  //返回值为true表示pre优先级高于nxt
  private readonly comparator: (pre: T, nxt: T) => boolean;

  private swap(index1: number, index2: number): void {
    [this.heap[index1], this.heap[index2]] = [
      this.heap[index2],
      this.heap[index1],
    ];
  }

  private shiftUp(index: number): void {
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
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.shiftDown(i);
    }
  }

  constructor(arr: T[], comparator: (pre: T, nxt: T) => boolean) {
    if (typeof comparator !== 'function') {
      throw new Error('Comparator must be a function');
    }
    this.heap = arr || [];
    this.comparator = comparator;
    this.heapify();
  }

  public push(item: T): void {
    this.heap.push(item);
    this.shiftUp(this.heap.length - 1);
  }

  public pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    this.swap(0, this.heap.length - 1);
    const poppedItem = this.heap.pop()!;
    this.shiftDown(0);
    return poppedItem;
  }

  public clear(): void {
    this.heap.length = 0;
  }

  get size(): number {
    return this.heap.length;
  }

  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  get peek(): T | undefined {
    return this.heap[0];
  }
}
