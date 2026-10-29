# 模块设计：collections（泛型容器）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/lib/collections/` |
| 架构章节 | 4.5 collections、8.1 movement、8.2 spawnQueue、12.1 代码范式 |
| 成熟度 | 定稿 · M2 |

## 1. 职责

三种泛型容器，由使用方创建并持有：

| 容器 | 使用方 |
| --- | --- |
| `PriorityQueue<T>` | spawnQueue 按"优先级、deadline"出队（8.2）；寻路预算按优先级分配（8.1.2） |
| `BucketQueue<T>` | 交通结算按优先级类别依次处理意图（8.1.3）；小整数代价的扩展 |
| `LruCache<K, V>` | costMatrix 与路径缓存按容量淘汰（7.3、8.1.2） |

三者都是无继承的扁平 class，字段在构造时按固定顺序初始化（12.1）；容器不复制、不修改元素。本模块没有模块级实例或可变状态，缓存只在 heap 中，global reset 后由使用方惰性重建。

## 2. 优先队列

- 二叉堆。比较函数 `Comparator<T>` 与 `Array.prototype.sort` 的约定相同：`compare(a, b) < 0` 表示 a 先出队。
- 相等元素的出队顺序不保证稳定，需要稳定时在比较函数中加入次序键（例如入队序号）。
- `push`、`pop` 为 O(log n)，`peek` 为 O(1)；`PriorityQueue.from(items, compare)` 自底向上建堆，为 O(n)，适合每 tick 重新声明的请求一次建队。
- `pop` 缩短内部数组，不保留已出队元素的引用；`clear` 只把长度置 0，数组复用。

## 3. 分桶队列

- 桶号为 0 到 `levels − 1` 的整数，`pop` 先取桶号最小的非空桶，同一桶内先进先出，结果确定。按"优先级越高越先"使用时，以 `levels − 1 − 优先级` 作为桶号。
- `push` 为 O(1)；`pop` 摊还 O(1)：游标只在出队时向大桶号移动，向更小的桶号 push 时回退。`peekBucket` 给出下一个出队元素所在的桶号，便于按桶批量处理（例如交通结算在同一优先级类别内再按可选格数排序）。
- 每个桶是数组加读指针；桶被取空时长度与读指针归零，数组复用。部分取出的桶在 `clear` 或取空之前仍持有已出队元素的引用，适合每 tick 用完即清的用法。
- 构造参数与桶号不是合法整数时抛 `RangeError`。

## 4. LRU 缓存

- 基于 `Map` 的插入顺序：命中时删除再插入，`Map` 的第一个键就是最久未用的条目，不另建链表；`get`、`set`、`delete` 都是 O(1)。
- `get` 刷新使用顺序，`peek`、`has`、`keys` 不刷新；值可以是 `undefined`，用 `has` 区分。
- `set` 超出容量时淘汰最久未用的条目，并调用构造时传入的 `onEvict(key, value)`；`delete` 与 `clear` 不调用回调。
- 容量不是正整数时抛 `RangeError`。

## 5. 接口与用法

```ts
type Comparator<T> = (a: T, b: T) => number

class PriorityQueue<T> {
  constructor(compare: Comparator<T>)
  static from<T>(items: Iterable<T>, compare: Comparator<T>): PriorityQueue<T>
  readonly size: number
  push(item: T): void
  pop(): T | undefined
  peek(): T | undefined
  clear(): void
}

class BucketQueue<T> {
  constructor(levels: number)
  readonly levels: number
  readonly size: number
  push(item: T, bucket: number): void
  pop(): T | undefined
  peekBucket(): number          // 空队列为 −1
  clear(): void
}

class LruCache<K, V> {
  constructor(capacity: number, onEvict?: (key: K, value: V) => void)
  readonly capacity: number
  readonly size: number
  get(key: K): V | undefined
  peek(key: K): V | undefined
  has(key: K): boolean
  set(key: K, value: V): this
  delete(key: K): boolean
  clear(): void
  keys(): MapIterator<K>        // 最久未用在前
}
```

```ts
const queue = PriorityQueue.from(requests, (a, b) => b.priority - a.priority || a.deadline - b.deadline);
const paths = new LruCache<string, Path>(500);   // { [creep 名]: 路径 }
```

## 6. 验证

单元测试中，`PriorityQueue` 以逐个 `push` 与 `from` 两种方式建堆，出队顺序与排序结果对拍，并与随机交替的 `push`、`pop` 参考序列比对；`BucketQueue` 与稳定排序对拍，覆盖游标回退、`peekBucket`、`clear` 后复用与参数校验；`LruCache` 覆盖淘汰顺序、刷新语义、值为 `undefined` 的条目、回调时机与参数校验。泛型推断以显式类型的赋值在类型检查中确认。
