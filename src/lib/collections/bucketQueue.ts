/**
 * 文件摘要：lib.collections 的泛型分桶队列，设计见 docs/design/lib/collections.md。
 *
 * 所属位置：src/lib/collections/，由 index.ts 导出。供交通结算按优先级类别（生存 > 战斗 > 物流 > 工作 > 闲置，架构 8.1.3）
 * 依次处理意图，以及小整数代价的最短路扩展等使用。
 * 语义：桶号为 0 到 levels − 1 的整数，pop 先取桶号最小的非空桶；同一桶内先进先出，结果确定。
 * 桶号越小越先出队：按"优先级越高越先"使用时，调用方以 levels − 1 − 优先级作为桶号。
 * 复杂度：push 为 O(1)；pop 摊还 O(1 + 桶号跨度)：游标只在出队时向大桶号移动，push 到更小的桶号时回退。
 * 状态：每个桶是一个数组加读指针；桶被取空时长度与读指针归零，数组复用。部分取出的桶在 clear 或取空前仍持有已出队元素的引用。
 */

/**
 * 泛型分桶队列。
 * @template T 元素类型；队列不复制、不修改元素。
 */
export class BucketQueue<T> {
  /** 桶数组，下标为桶号；每个桶按入队顺序保存元素。 */
  private readonly buckets: T[][];
  /** 各桶的读指针，下标为桶号；heads[b] 之前的元素已出队。 */
  private readonly heads: Uint32Array;
  /** 可能非空的最小桶号；所有更小的桶都为空。 */
  private cursor: number;
  /** 当前元素个数。 */
  private count: number;

  /**
   * @description 创建空队列。
   * @param levels 桶的个数，正整数。
   * @throws {RangeError} levels 不是正整数。
   */
  constructor(levels: number) {
    if (!Number.isInteger(levels) || levels < 1) throw new RangeError('桶的个数必须是正整数');
    this.buckets = Array.from({ length: levels }, (): T[] => []);
    this.heads = new Uint32Array(levels);
    this.cursor = levels;
    this.count = 0;
  }

  /**
   * @description 桶的个数。
   * @returns 创建时指定的 levels。
   */
  get levels(): number {
    return this.buckets.length;
  }

  /**
   * @description 当前元素个数。
   * @returns 元素个数。
   */
  get size(): number {
    return this.count;
  }

  /**
   * @description 把元素放入指定的桶。
   * @param item 元素。
   * @param bucket 桶号，0 到 levels − 1 的整数。
   * @returns 无返回值；修改队列。
   * @throws {RangeError} 桶号不是该范围内的整数。
   */
  push(item: T, bucket: number): void {
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= this.buckets.length) throw new RangeError('桶号超出范围');
    this.buckets[bucket].push(item);
    this.count += 1;
    if (bucket < this.cursor) this.cursor = bucket;
  }

  /**
   * @description 取出桶号最小的非空桶中最早入队的元素。
   * @returns 该元素；队列为空时为 undefined。
   */
  pop(): T | undefined {
    const b = this.advance();
    if (b < 0) return undefined;
    const items = this.buckets[b];
    const item = items[this.heads[b]];
    this.heads[b] += 1;
    if (this.heads[b] === items.length) {
      items.length = 0;
      this.heads[b] = 0;
    }
    this.count -= 1;
    return item;
  }

  /**
   * @description 下一个出队元素所在的桶号，用于按桶批量处理（例如同一优先级类别内再排序）。
   * @returns 桶号；队列为空时为 −1。
   */
  peekBucket(): number {
    return this.advance();
  }

  /**
   * @description 清空队列，保留各桶数组以便复用。
   * @returns 无返回值；释放全部元素引用。
   */
  clear(): void {
    for (let b = 0; b < this.buckets.length; b += 1) this.buckets[b].length = 0;
    this.heads.fill(0);
    this.cursor = this.buckets.length;
    this.count = 0;
  }

  /**
   * @description 把游标移到第一个非空桶。
   * @returns 该桶号；队列为空时为 −1，游标停在 levels。
   */
  private advance(): number {
    if (this.count === 0) {
      this.cursor = this.buckets.length;
      return -1;
    }
    // count > 0 保证在 levels 之前一定找到非空桶。
    while (this.heads[this.cursor] === this.buckets[this.cursor].length) this.cursor += 1;
    return this.cursor;
  }
}
