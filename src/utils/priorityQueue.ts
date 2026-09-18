/**
 * 文件摘要
 *
 * 模块角色：utils 的通用数据结构实现，为需要反复取最高优先级元素的算法提供队列。
 *
 * 主要功能：接收初始数组和比较器，提供 push、pop、clear，以及 peek、size、isEmpty 查询。
 *
 * 实现过程：用数组表示二叉堆，构造时从末尾父节点向上建堆；入队时上浮，出队时替换根并下沉。
 *
 * 技术要点：建堆 O(n)，入队和出队 O(log n)，查看堆顶 O(1)；空队列查询或弹出返回 undefined。
 * 内部直接复用并修改传入数组，同优先级顺序不保证稳定；实例可跨 tick 保留，global reset 后需重建。
 * 队列不读取游戏环境或持久存储，调用方需保证比较器一致且不绕过队列修改数组。
 */
export class PriorityQueue<T> {
  /**
   * 紧凑数组形式的二叉堆；下标 0 始终保存当前最高优先级元素。
   *
   * 数组下标 `i` 的子节点为 `2i+1`、`2i+2`，父节点为 `floor((i-1)/2)`。
   * readonly 只约束“引用不能重新指向别的数组”，并不冻结内容：heapify/push/pop/clear
   * 都会原地修改它。字段初始化器先建一个空数组、构造函数随即用调用方数组替换，
   * 目的是让字段在声明处即有明确初值；真正的数据始终来自构造参数。
   */
  private readonly heap: T[] = [];
  /**
   * 返回 true 表示 pre 的优先级高于 nxt；具体排序方向由调用方定义。
   *
   * 堆序完全依赖该函数的自洽性：比较器应满足传递性与反对称性（同一对元素不能同时
   * 判定 pre 高于 nxt 与 nxt 高于 pre），否则 pop 顺序不再有保证。优先级相等的元素
   * 顺序不稳定，需要确定性结果时应在比较器中附加次级比较键。
   */
  private readonly comparator: (pre: T, nxt: T) => boolean;

  private swap(index1: number, index2: number): void {
    /**
     * 解构赋值在不创建显式临时变量的情况下交换两个堆节点。
     * 代价是每次交换会构造一个两元素临时数组；这里以少量分配换取可读性，
     * 若性能剖析显示交换是热点，可改用显式临时变量版本。
     */
    [this.heap[index1], this.heap[index2]] = [
      this.heap[index2],
      this.heap[index1],
    ];
  }

  private shiftUp(index: number): void {
    /**
     * 新节点持续与父节点比较，直至到达根或已满足堆序。
     * `index === 0` 的提前返回是“插入即根”这一常见路径的短路，避免进入循环判断。
     * 每轮至少上移一层，循环次数不超过树高，即 O(log n)。
     */
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
    /**
     * 根节点替换后持续选择优先级最高的子节点交换，以恢复整棵堆。
     *
     * nxtIndex 先指向自身，只有左/右子节点确实存在且优先级更高时才改写它，
     * 因此比较对象始终是“当前最优候选”，无需分别为两个子节点写分支。
     * 循环在叶子或已满足堆序时退出，深度不超过树高，即 O(log n)。
     */
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
     *
     * 利用了“叶子本身已是合法堆”的性质，比逐个 push 的 O(n log n) 更省，
     * 因此适合构造时就传入成批候选元素的场景（例如把起点集合一次性放入队列）。
     */
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.shiftDown(i);
    }
  }

  constructor(arr: T[], comparator: (pre: T, nxt: T) => boolean) {
    /**
     * 比较器是维持堆序的必要依赖，构造阶段提前拒绝无效值。
     *
     * 类型上 comparator 必填，运行时的 typeof 校验用于挡住 JS 调用方或类型断言
     * 绕过检查的情况：缺少比较器时堆序会静默失效，不如在构造阶段立即抛错。
     */
    if (typeof comparator !== 'function') {
      throw new Error('Comparator must be a function');
    }
    /**
     * 直接复用调用方数组：不复制、不预分配，heapify 原地整理，这是刻意的零拷贝取舍。
     * 代价是队列与调用方共享同一数组，push/pop/clear 都会反映到原数组上，
     * 因此数组移交后调用方不应再并行读写它；`arr || []` 兜住运行时传入 null/undefined 的情况。
     */
    this.heap = arr || [];
    this.comparator = comparator;
    this.heapify();
  }

  public push(item: T): void {
    /** 先追加到数组末尾，再上浮新节点恢复堆序；O(log n)，扩容由数组自身承担。 */
    this.heap.push(item);
    this.shiftUp(this.heap.length - 1);
  }

  public pop(): T | undefined {
    /**
     * 将根与末尾交换后弹出最高优先级元素，再从根下沉替代节点。
     * 空队列返回 undefined，与原生 Array.pop 的语义一致。
     *
     * `!` 断言的理由：前面的 length 判断已排除空队列，但 TypeScript 无法据此收窄
     * Array.prototype.pop 的返回类型，因此显式声明此处必有值。
     */
    if (this.heap.length === 0) return undefined;
    this.swap(0, this.heap.length - 1);
    const poppedItem = this.heap.pop()!;
    this.shiftDown(0);
    return poppedItem;
  }

  public clear(): void {
    /**
     * 原地截断数组，保留内部引用并释放所有元素引用。
     * 复用同一个实例（例如每 tick 复用的寻路队列）时可避免重新分配数组。
     */
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
    /**
     * 只读最高优先级元素而不修改堆；空队列返回 undefined。
     * 适合“先查看再决定是否弹出”的场景，避免 pop 后再 push 回去。
     */
    return this.heap[0];
  }
}
