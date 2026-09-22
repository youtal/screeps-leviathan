# 提案：跨 tick 高消耗任务框架

- 状态：待决策
- 提出日期：2026-09-23
- 范围：为业务模块提供“把一段高消耗计算分摊到多个 tick 完成”的能力
- 导航：[提案索引](./README.md)

## 1. 要解决的问题

房间布局规划、成本矩阵构建、大范围寻路预计算这类工作，单次耗时可能超过一个 tick 的 CPU 额度。需要的接口形如“交给框架一个计算，它在若干 tick 内算完并给出结果”。难点是：如何安全地中断正在执行的计算，并在下一个 tick 从中断处完整继续。

## 2. 结论先行：不能中断任意回调

JavaScript 没有抢占式调度。一个同步函数一旦开始执行，宿主代码就无法在它中间插入控制流，也无法读取或重建它的栈帧、局部变量与闭包引用。Screeps 唯一的“中断”是 CPU 硬终止，它结束的是整个 tick 的执行，不能恢复到函数中间。

因此接口不能接受任意函数，必须让**挂起点显式化**。可选机制：

| 机制 | 说明 | 结论 |
| --- | --- | --- |
| 生成器（`function*`） | 语言提供的可保存执行状态：`yield` 处挂起，`next()` 处恢复，局部变量与执行位置由引擎保存在堆上 | **推荐**。挂起点显式、无序列化成本、恢复精确 |
| 显式状态机 | 把任务拆成 `step(state) → state`，状态是普通数据 | 作为补充：状态可序列化，能跨 global reset 存活，代价是要手工拆分控制流 |
| `async`/`await` | 依赖微任务队列跨 tick 续跑 | 不采用。tick 在 loop 返回后结束，续体的执行时机不由代码控制，CPU 归属与错误边界都无法保证；项目的同步钩子契约也拒绝返回 Promise |
| JS 写的解释器 | 逐条解释执行，可随时快照 | 不采用。解释执行比原生慢一到两个数量级，与“省 CPU”的目的相反 |
| 线程、纤程、独立 isolate | worker_threads、Fiber、isolated-vm | 运行环境不提供 |

所以“安全终止”这件事的真实含义是：**只在任务自己声明的安全点停止驱动**。任务保证每个 `yield` 处的数据结构是自洽的，框架保证不在别处打断它。

## 3. 接口草案

```ts
/** 任务体：收到上下文，返回一个在安全点 yield 的生成器。 */
type TaskBody<T> = (context: TaskContext) => Generator<void, T, void>;

interface TaskContext {
  /** 当前 tick；每次恢复都会更新，任务不要自己缓存 tick。 */
  readonly tick: number;
  /** 本 tick 该任务已消耗的 CPU，用于任务内部决定分片粒度。 */
  readonly used: number;
}

interface TaskHandle<T> {
  readonly id: string;
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
  /** state 为 done 时有效。 */
  readonly result?: T;
  /** state 为 failed 时给出结构化故障，与插件故障同构。 */
  readonly failure?: PluginFailure;
  cancel(): void;
}

interface TaskScheduler {
  /** 同 id 重复提交返回已有句柄，因此调用方可以每 tick 无条件调用。 */
  submit<T>(id: string, body: TaskBody<T>, options?: TaskOptions): TaskHandle<T>;
  get<T>(id: string): TaskHandle<T> | undefined;
}

interface TaskOptions {
  /** 调度优先级，大者先获得 CPU；缺省 0。 */
  priority?: number;
  /** 从首次运行起的存活上限，超过即 expired 并释放。 */
  deadlineTicks?: number;
  /** 低于该 bucket 时不驱动，缺省高于框架的普通插件门限。 */
  minBucket?: number;
}
```

调用方按 id 提交、按状态取结果，不使用完成回调：

```ts
onTickExecute(context) {
  const plan = tasks.submit('layout:W1N1', planLayout('W1N1'), { priority: 5 });
  if (plan.state === 'done') applyLayout(plan.result!);
}

function* planLayout(roomName: string) {
  const terrain = Game.map.getRoomTerrain(roomName);
  const result = createEmptyPlan();
  for (let y = 0; y < 50; y++) {
    scanRow(terrain, result, y); // 热循环留在普通函数里
    yield;                       // 行与行之间是安全点
  }
  return result;
}
```

不采用完成回调的理由：回调的执行阶段与归属插件由调度器决定，会重演事件回调那一类归属问题（参见 [Framework 设计 §5.2](../design/core/framework.md)）。轮询状态让结果读取发生在调用方自己的钩子里，错误边界与 CPU 归属都清晰。

## 4. 调度与预算

- **运行时机**：调度器本身是一个普通插件，优先级最低，在执行阶段的末尾驱动任务，让业务插件先拿到 CPU。任务只做计算，不提交意图。
- **预算**：`while (还有任务 && cpu.remaining() > 预留 && bucket 达标)` 驱动一次 `next()`。单个任务每 tick 有片额上限，避免一个任务吃掉整轮剩余 CPU。
- **公平性**：就绪任务按优先级排序（可直接复用 [PriorityQueue](../design/utils/priorityQueue.md)），同优先级轮转。
- **观测**：每个任务一个 Profiler 标签（`task.<id>`），任务 id 因此必须是固定且有限的集合。
- **上限**：`deadlineTicks` 到期标记 `expired` 并释放生成器，防止写错的任务永久占用调度器。

## 5. 分片粒度：来自实测的约定

Node 中对一个纯算术循环（500 万次迭代）的测量，只用于量级参考：

| 写法 | 相对直算的额外开销 |
| --- | --- |
| 热循环写在生成器体内，每次迭代 `yield` | 约 +180% |
| 热循环写在生成器体内，每 100–10000 次迭代 `yield` | 约 +65%（不随 yield 变稀疏而下降） |
| 热循环留在普通函数里，生成器只在分片之间 `yield`（每片约 0.15 ms） | 约 +1% |

两条结论：

1. **生成器体本身就比普通函数慢**（引擎对生成器体的优化更弱），所以热循环不要写在生成器里，生成器只负责调用分片函数并在分片之间让出。
2. 单次 `yield` 加一次预算检查在 20 ns 量级；把分片取到“每片 0.1 ms 以上”时，让出成本落在测量噪声范围内。更细的分片会让调用与让出开销重新变得可观。

## 6. 安全性与恢复

- **安全点契约**：任务保证每个 `yield` 处的中间数据自洽，可以在任意多个 tick 之后继续。
- **禁止跨 tick 持有游戏对象**：生成器的局部变量会跨 tick 存活，因此局部变量里不能保存 `Room`、`Creep`、`Structure` 等当 tick 对象；需要时在恢复后按 id 重新取得。`RoomPosition`、地形、纯数据结构可以保留。
- **硬终止**：CPU 硬终止会在任意指令处打断驱动，生成器可能停在“执行中”状态，此时再次 `next()` 可能抛错。对策与项目既有做法一致：驱动前写入带 tick 归属的运行标记，下一 tick 发现标记来自旧 tick，即判定该任务被硬终止打断，默认丢弃并按 id 重新开始。**需要在私服的硬终止场景中实测确认引擎的真实行为**，再决定是丢弃还是可以继续驱动。
- **global reset**：生成器状态只在 heap，reset 后任务注册表为空。任务必须可重启：调用方每 tick 无条件 `submit`，同 id 幂等，reset 后自然重新开始。
- **失败隔离**：驱动发生在调度器插件自己的错误边界内，失败写入句柄，由提交者读取，不影响其他任务与插件。
- **取消**：`cancel()` 释放生成器与队列位置；已完成的结果保留到被读取或过期。

## 7. 边界

- **原生调用不可切分**：`PathFinder.search`、`room.find`、市场接口等是一次性的原生调用，中途无法让出。任务只能在调用之间让出，并自行把大搜索拆成多次小搜索。
- **结果占用 heap**：未被读取的结果会一直驻留，需配合 `deadlineTicks` 与读取后释放。
- **不保证完成时间**：低 bucket 时任务会长期停摆，调用方必须容忍“暂时没有结果”。

## 8. 可选扩展：检查点

任务可以在 `yield` 时交出一个可序列化的检查点，由提交者写进自己的分区，global reset 后从检查点继续。代价是每次检查点的校验与编码开销，只对“耗时以万 CPU 计”的任务值得。这属于 MemoryManager 的常规用法，不需要新机制，建议不列入首版。

## 9. 待决问题

1. 首版是否包含检查点与事件通知，还是只提供轮询。
2. 任务是否允许嵌套提交子任务（涉及优先级继承与死锁判断）。
3. 调度器归属：作为通用能力层的一个插件，还是 Core 的一部分。它本身不依赖 Screeps 概念，但需要 CPU 与 bucket 信息；与[通用能力层提案](./capability-layer.md)一并决定。
4. 任务失败后的重试策略：交给调用方，还是提供 `retry` 选项。
