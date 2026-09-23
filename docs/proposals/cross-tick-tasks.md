# 提案：跨 tick 高消耗任务框架

- 状态：已采纳并交付——机制选定为生成器方案（§2），调度器归入 Core 作为内核能力；见 [TaskScheduler 设计](../design/core/taskScheduler.md)与[使用说明](../usage/core/taskScheduler.md)
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
  /** state 为 failed 时给出结构化故障，与插件故障同构；pluginId/phase 归属规则见 §6 失败隔离。 */
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
  /**
   * Profiler 标签与健康统计使用的分类键，必须来自固定且有限的集合（与 PluginManifest.id
   * “不能按房间、任务等动态数据生成”的约束同源，见 §4 观测）。缺省回退到 id 本身；因此
   * 调用方一旦按业务动态拼接 id（例如按房间区分任务实例），必须显式提供固定的 label，
   * 否则会在 Profiler 报告和健康表里产生无界增长的键。
   */
  label?: string;
}
```

调用方按 id 提交、按状态取结果，不使用完成回调：

```ts
onTickExecute(context) {
  const plan = tasks.submit('layout:W1N1', planLayout('W1N1'), {
    priority: 5,
    label: 'layout', // 固定分类键；'W1N1' 只出现在 id 里，不进入 Profiler 标签。
  });
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

> 注（2026-09-23）：上例把 `planLayout('W1N1')` 返回的生成器对象直接传给 `submit`，与 `TaskBody`（返回生成器的函数）不符，正确写法是 `() => planLayout('W1N1')`。实例语义（终态保留与 `release`）、CPU 口径与硬终止恢复在落地时均有调整，以 [TaskScheduler 设计](../design/core/taskScheduler.md) 为准。

不采用完成回调的理由：回调的执行阶段与归属插件由调度器决定，会重演事件回调那一类归属问题（参见 [Framework 设计 §5.2](../design/core/framework.md)）。轮询状态让结果读取发生在调用方自己的钩子里，错误边界与 CPU 归属都清晰。

## 4. 调度与预算

- **运行时机**：调度器本身是一个普通插件，优先级最低，在执行阶段的末尾驱动任务，让业务插件先拿到 CPU。任务只做计算，不提交意图。
- **预算**：`while (还有任务 && cpu.remaining() > 预留 && bucket 达标)` 驱动一次 `next()`。单个任务每 tick 有片额上限，避免一个任务吃掉整轮剩余 CPU。
- **公平性**：就绪任务按优先级排序，可复用 [PriorityQueue](../design/utils/priorityQueue.md) 提供堆序；但它本身不保证同优先级的稳定或轮转顺序（其设计明确要求调用方在比较器里附加次级键）。只加一个固定次级键（例如 [IntentBroker](../design/core/framework.md) 用“提交序号升序”破平）得到的是稳定的先到先得，同优先级里靠后提交的任务会一直排在后面，仍不是轮转。真正的轮转需要次级键在任务每次被驱动后更新（例如记录“最近一次被驱动的轮次”并重新入队），这部分需要调度器自行维护，不是复用 PriorityQueue 就能获得的。
- **观测**：每个任务的 Profiler 标签是 `task.<label>`，`label` 必须来自固定且有限的集合——这与 `PluginManifest.id`“不能按房间、任务等动态数据生成”的约束（`src/contracts/plugin.ts`）同源：Profiler 与健康表都按键长期建表，动态键会造成无界增长。提交时用于去重/查询的 `id` 允许按业务拼入动态数据（例如按房间区分任务实例，见 §3 示例），但只作调度器内部注册表的键，不能直接当 `label` 使用。
- **上限**：`deadlineTicks` 到期标记 `expired` 并释放生成器，防止写错的任务永久占用调度器。

## 5. 分片粒度与落地可行性

### 5.1 来自实测的约定

Node 中对一个纯算术循环（500 万次迭代）的测量，只用于量级参考，未记录具体 Node/V8 版本：

| 写法 | 相对直算的额外开销 |
| --- | --- |
| 热循环写在生成器体内，每次迭代 `yield` | 约 +180% |
| 热循环写在生成器体内，每 100–10000 次迭代 `yield` | 约 +65%（不随 yield 变稀疏而下降） |
| 热循环留在普通函数里，生成器只在分片之间 `yield`（每片约 0.15 ms） | 约 +1% |

两条结论：

1. **生成器体本身就比普通函数慢**（引擎对生成器体的优化更弱），所以热循环不要写在生成器里，生成器只负责调用分片函数并在分片之间让出。
2. 单次 `yield` 加一次预算检查在 20 ns 量级；把分片取到“每片 0.1 ms 以上”时，让出成本落在测量噪声范围内。更细的分片会让调用与让出开销重新变得可观。

以上比例数字会随 V8 版本浮动，只作方向性参考；最终结论以 §5.2 的真机 Profiler 实测为准，这与下文“安全性与恢复”一节里硬终止行为需要私服验证的态度一致。

### 5.2 工具链与引擎核查

针对本项目实际工具链做了以下验证，确认生成器方案在现有代码库里没有机制性障碍：

- **编译目标**：`tsconfig.json` 的 `target` 是 `es2017`，原生支持生成器语法。用项目相同的 `target`/`strict` 设置编译一段模拟 `TaskBody` 的生成器代码，产物是原生 `function*`，没有出现 `regeneratorRuntime`/`__generator` 之类的状态机降级代码，说明生成器不会引入额外转译层或体积膨胀。
- **跨调用恢复**：用两次独立调用模拟“驱动到一半后中断”与“之后继续驱动”，生成器在两次调用之间正确保留了局部变量与执行位置，验证了 §2 依赖的核心假设——挂起状态在堆上完整存活，与调用方何时再次 `next()` 无关。
- **构建管线**：`rollup.config.mjs` 里唯一的 minify 步骤（`html-minifier-terser`）只作用于 HTML 模板字符串导入，JS 产物不经过任何压缩或降级插件，生成器语法会原样进入 `dist/main.js`。
- **运行引擎**：集成测试使用的真实 Screeps 引擎（engine 4.3.2，见[集成测试文档](../testing/integration.md)）以 Node.js 宿主执行玩家 isolate，不是自定义或裁剪过的解释器，生成器机制本身不需要额外验证——需要私服验证的只是硬终止时序这类行为细节，而不是“引擎是否支持生成器”。
- **代码库现状**：`src/` 下目前没有任何 `function*`/`yield` 用例，这是项目第一次引入生成器模式，没有可复用的既有测试或约定，落地时需要新建一套验证“跨调用状态保持正确”的单元测试。

一个由此核查引出的新风险点：`CpuGovernor.remaining()` 每次调用都会重新采样 `Game.cpu.getUsed()`（`createCpuGovernor` 自身注释已提示“不应在紧循环里逐条意图反复查询”）。按 §5.1 建议的分片粒度（约 0.15 ms/片）估算，一个用满预算的 tick 大致会触发到低几百次采样，量级上可控，但这只是估算，落地后应当用 Profiler 实测调度循环自身占用的 CPU 比例，确认采样开销没有侵蚀省下来的收益。

## 6. 安全性与恢复

- **安全点契约**：任务保证每个 `yield` 处的中间数据自洽，可以在任意多个 tick 之后继续。
- **禁止跨 tick 持有游戏对象**：生成器的局部变量会跨 tick 存活，因此局部变量里不能保存 `Room`、`Creep`、`Structure` 等当 tick 对象；需要时在恢复后按 id 重新取得。`RoomPosition`、地形、纯数据结构可以保留。
- **硬终止**：CPU 硬终止会在任意指令处打断驱动，生成器可能停在“执行中”状态，此时再次 `next()` 可能抛错。对策与项目既有做法一致：驱动前写入带 tick 归属的运行标记，下一 tick 发现标记来自旧 tick，即判定该任务被硬终止打断，默认丢弃并按 id 重新开始。**需要在私服的硬终止场景中实测确认引擎的真实行为**，再决定是丢弃还是可以继续驱动。
- **global reset**：生成器状态只在 heap，reset 后任务注册表为空。任务必须可重启：调用方每 tick 无条件 `submit`，同 id 幂等，reset 后自然重新开始。
- **失败隔离**：驱动发生在调度器插件自己的错误边界内，失败写入句柄，由提交者读取，不影响其他任务与插件。写入 `TaskHandle.failure` 的 `PluginFailure`（见 §3）里，`pluginId` 固定填调度器自身的插件 id、`phase` 固定为驱动发生的阶段，而不是提交任务的业务插件——原因和 §3 否决完成回调一致：真正的执行者是调度器，不应该借 `pluginId` 冒充提交者身份。代价是提交者身份不会出现在 `PluginFailure` 里，需要按提交者排查故障时只能依赖 `id` 的命名约定；这一权衡列入 §9 待决问题。
- **取消**：`cancel()` 释放生成器与队列位置；已完成的结果保留到被读取或过期。
- **终态后的重新提交**：`done`、`failed`、`cancelled`、`expired` 都不会阻止调用方按同一个 `id` 再次 `submit`；只有 `queued`/`running` 会返回原句柄（“同 id 重复提交返回已有句柄”仅适用于这两种状态）。`failed`/`cancelled`/`expired` 再次提交会丢弃旧句柄并从头创建生成器；`done` 的结果在被读取之前不会被新提交覆盖，避免调用方读取时结果突然消失。

## 7. 边界

- **原生调用不可切分**：`PathFinder.search`、`room.find`、市场接口等是一次性的原生调用，中途无法让出。任务只能在调用之间让出，并自行把大搜索拆成多次小搜索。
- **结果占用 heap**：未被读取的结果会一直驻留，需配合 `deadlineTicks` 与读取后释放。
- **不保证完成时间**：低 bucket 时任务会长期停摆，调用方必须容忍“暂时没有结果”。

## 8. 可选扩展：检查点

任务可以在 `yield` 时交出一个可序列化的检查点，由提交者写进自己的分区，global reset 后从检查点继续。代价是每次检查点的校验与编码开销，只对“耗时以万 CPU 计”的任务值得。这属于 MemoryManager 的常规用法，不需要新机制，建议不列入首版。

## 9. 待决问题

1. 首版是否包含检查点与事件通知，还是只提供轮询。
2. 任务是否允许嵌套提交子任务（涉及优先级继承与死锁判断）。
3. ~~调度器归属：作为通用能力层的一个插件，还是 Core 的一部分。~~ 已决定：归入 Core 作为内核能力，不走插件注册；由此带来的接口调整（`context.tasks` 直接接入、`TaskHost.bind(owner)` 归属失败诊断）见 [TaskScheduler 设计](../design/core/taskScheduler.md)。
4. 任务失败后的重试策略：交给调用方，还是提供 `retry` 选项。
5. `label` 是否需要在类型层强制要求（例如让 `submit` 在 `id` 与 `label` 不同时才允许省略 `label`），而不是只靠约定与代码评审防止动态 id 混入 Profiler 标签。
6. 任务失败的 `PluginFailure` 是否需要额外携带提交者插件 id：当前建议只保留调度器自身 id，提交者身份退化为 `id` 的命名约定，是否足够、要不要为此单独加字段。
