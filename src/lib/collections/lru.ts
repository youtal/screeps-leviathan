/**
 * 文件摘要：lib.collections 的泛型 LRU 缓存，设计见 docs/design/lib/collections.md。
 *
 * 所属位置：src/lib/collections/，由 index.ts 导出。供 costMatrix、路径缓存等按容量淘汰最久未用的条目。
 * 实现：基于 Map 的插入顺序——命中时删除再插入，使该键移到末尾，Map 的第一个键就是最久未用的条目；
 * 不另建链表，get、set、delete 都是 O(1)。
 * 状态：实例持有一个 Map 与可选的淘汰回调。缓存只在 heap 中，global reset 后为空，由使用方惰性重建。
 */

/**
 * 泛型 LRU 缓存。
 * @template K 键类型，按 Map 的 SameValueZero 规则比较。
 * @template V 值类型，可以包含 undefined；用 has 区分"没有该键"与"值为 undefined"。
 */
export class LruCache<K, V> {
  /** 条目：{ [键]: 值 }，迭代顺序为最近使用顺序，最久未用的在前。 */
  private readonly entries: Map<K, V>;
  /** 容量上限。 */
  readonly capacity: number;
  /** 条目因超出容量被淘汰时调用；delete 与 clear 不调用。 */
  private readonly onEvict: ((key: K, value: V) => void) | undefined;

  /**
   * @description 创建空缓存。
   * @param capacity 容量上限，正整数。
   * @param onEvict 可选的淘汰回调，参数为被淘汰的键与值，例如释放与该条目关联的资源。
   * @throws {RangeError} capacity 不是正整数。
   * @example
   * const matrices = new LruCache<string, CostMatrix>(30); // { [房间名]: 成本矩阵 }
   */
  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('容量必须是正整数');
    this.entries = new Map();
    this.capacity = capacity;
    this.onEvict = onEvict;
  }

  /**
   * @description 当前条目数。
   * @returns 条目数。
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * @description 读取并把该键标为最近使用。
   * @param key 键。
   * @returns 值；没有该键时为 undefined。
   */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    // has 为 true 后 get 返回的就是存入的值（可能本身是 undefined），断言为 V 不改变运行时语义。
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * @description 读取但不改变使用顺序。
   * @param key 键。
   * @returns 值；没有该键时为 undefined。
   */
  peek(key: K): V | undefined {
    return this.entries.get(key);
  }

  /**
   * @description 是否有该键，不改变使用顺序。
   * @param key 键。
   * @returns 有该键时为 true。
   */
  has(key: K): boolean {
    return this.entries.has(key);
  }

  /**
   * @description 写入并把该键标为最近使用；超出容量时淘汰最久未用的条目。
   * @param key 键。
   * @param value 值。
   * @returns 缓存本身，便于链式调用。
   */
  set(key: K, value: V): this {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      // size > capacity ≥ 1，所以迭代器第一个值一定存在。
      const oldest = this.entries.keys().next().value as K;
      const evicted = this.entries.get(oldest) as V;
      this.entries.delete(oldest);
      this.onEvict?.(oldest, evicted);
    }
    return this;
  }

  /**
   * @description 删除一个条目，不调用淘汰回调。
   * @param key 键。
   * @returns 原本有该键时为 true。
   */
  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /**
   * @description 清空缓存，不调用淘汰回调。
   * @returns 无返回值；释放全部条目。
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * @description 按最久未用到最近使用的顺序遍历键，不改变使用顺序。
   * @returns 键的迭代器。
   */
  keys(): MapIterator<K> {
    return this.entries.keys();
  }
}
