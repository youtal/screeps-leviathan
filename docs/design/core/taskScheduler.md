# TaskScheduler 设计

交付状态：设计已形成；运行时实现、契约类型、测试与使用说明均未交付。目标模块路径为 `src/core/taskScheduler/`。下文接口是设计协议，不是已发布 API。

## 1. 定位与目标

TaskScheduler 是 Core 的内核能力，把一段单 tick 内算不完的同步计算，用生成器分摊到多个 tick 完成。它只提供协作式调度、CPU 预算准入与失败隔离，不理解任务计算的具体业务含义；房间布局规划、成本矩阵构建、大范围寻路预计算等具体算法由调用方以生成器形式提供。

设计目标：

- 挂起点由任务自己在生成器里用 `yield` 显式声明，调度器只在这些点之间驱动，不尝试中断任意同步函数——JavaScript 没有抢占式调度，一个同步函数一旦开始执行，宿主代码无法在中间插入控制流或重建其栈帧、局部变量与闭包引用。
- 归属清晰：任务在谁的上下文里提交，失败诊断就归属谁，不需要额外的 id 命名约定来间接表达提交者身份。
- 与既有内核能力对齐：CPU 判断复用 `CpuBudget`、故障记录复用 `PluginFailure`、计时复用 Profiler、生命周期恢复复用 global reset 的既有约定，不新造一套准入或诊断口径。

## 2. 为什么是内核能力

TaskScheduler 不理解房间、建筑、寻路等游戏领域概念，纯粹是脚本基础设施，这与 Logging、EventBus、Profiler、ErrorMapper、MemoryManager 的定位一致（见 [Core 架构](./README.md) §2）。

它的驱动时机也不适合套用普通插件模型：调度需要在所有普通插件的 tickExecute、Intent 仲裁、tickEnd 与 Memory 收尾都完成后，用真正剩余的 CPU 驱动，而不是作为参与拓扑排序、可被 `disable`/熔断的普通插件之一。把"最后一个拿 CPU"这件事建立在插件优先级这种可被其它插件的注册顺序或依赖关系影响的弱约束上并不合适；做成 Runtime 直接组装的内核能力，驱动时机由 Framework 在自己的 loop 尾部显式调用，由 Kernel 保证而不是依赖约定。

TaskScheduler 依赖 Logger（自身诊断）、ErrorMapper（任务失败的堆栈捕获与映射）、Profiler（任务分片计时），不依赖 EventBus 与 MemoryManager（首版不提供跨 tick 检查点，见 §7）。

## 3. 对外协议

### 3.1 任务体与句柄

```ts
/** 任务体：收到上下文，返回一个在安全点 yield 的生成器。 */
type TaskBody<T> = (context: TaskContext) => Generator<void, T, void>;

interface TaskContext {
  /** 当前 tick；每次恢复都会更新，任务不要自己缓存 tick。 */
  readonly tick: number;
  /** 本任务本次 drive 累计消耗的 CPU；来自 CpuBudget.remaining() 的前后差值，见 §5.2。 */
  readonly used: number;
}

interface TaskHandle<T> {
  readonly id: string;
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
  /** state 为 done 时有效。 */
  readonly result?: T;
  /** state 为 failed 时给出结构化故障，与插件故障同构；归属规则见 §5.6。 */
  readonly failure?: PluginFailure;
  cancel(): void;
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
   * 的约束同源，见 §5.4）。缺省回退到 id 本身；调用方一旦按业务动态拼接 id（例如按房间
   * 区分任务实例），必须显式提供固定的 label。
   */
  label?: string;
}

/** 每个模块拿到的、已绑定 owner 的调度入口；见 §4。 */
interface TaskScheduler {
  /** 同 id 重复提交在 queued/running 时返回已有句柄；终态后的行为见 §5.5。 */
  submit<T>(id: string, body: TaskBody<T>, options?: TaskOptions): TaskHandle<T>;
  get<T>(id: string): TaskHandle<T> | undefined;
}
```

### 3.2 宿主端口

Runtime 组装、Framework 驱动的生命周期端口，形态对齐 [MemoryHost](../contracts.md)：

```ts
interface TaskHost {
  /** 按 owner（模块名/插件 id）派生绑定后的调度入口；构造与 bind 不产生调度副作用。 */
  bind(owner: string): TaskScheduler;
  /** Framework 在本 tick 收尾的最后阶段调用一次；见 §5.1 时序。 */
  drive(tick: number, cpu: CpuBudget): void;
  /** 最小诊断快照：就绪、运行中的任务计数；具体字段留待实现确定，见 §8。 */
  getStatus(): { queued: number; running: number };
}
```

`CoreRuntime` 增加 `readonly tasks: TaskHost`；`ModuleContext` 增加 `tasks?: TaskScheduler`（可选原因与 `memory?: ApplyMemoryAccessor` 一致：允许测试替身或特殊宿主构造不含调度能力的上下文）。`createContext` 内部调用 `taskHost.bind(moduleName)` 填充该字段，模块不自己调用 `bind`。

## 4. 消费方式

业务钩子直接从 `context.tasks` 取得已绑定的调度入口，不经过 `manifest.requires`/`services.get`——这与 `context.memory`、`context.cpu` 是同一种接入方式：TaskScheduler 是内核能力而不是可选服务，所有模块的上下文里都直接可用。

```ts
onTickExecute(context) {
  const plan = context.tasks.submit('layout:W1N1', planLayout('W1N1'), {
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

不提供完成回调：回调的执行阶段与归属插件由调度器决定，会重演事件回调那一类归属问题（见 [Framework 设计](./framework.md) §5.2）。轮询状态让结果读取发生在调用方自己的钩子里，错误边界与 CPU 归属都清晰。

`id` 只需要在同一 owner 内唯一——`bind(owner)` 已经把不同模块的任务隔离在各自的命名空间，不同插件用相同的 `id` 不会互相冲突。

## 5. 调度、归属与恢复

### 5.1 驱动时机

Framework 在一个 tick 内的既有时序（[Framework 设计](./framework.md) §4）之后追加一步：

```text
tickBegin → tickExecute(plan → arbitrate → commit) → tickEnd（逆序）
→ 健康/熔断统计 → MemoryHost.end → TaskHost.drive(tick, cpu)
```

`drive` 严格排在 `MemoryHost.end` 之后：任务只做计算、不提交意图，与 Memory 提交没有依赖关系；排在最后可以保证任务调度不会挤占插件收尾、健康统计或 Memory 持久化所需的 CPU，即使任务的分片粒度估算有偏差，最坏结果也只是任务本身进度落后，不影响其它环节。

`drive` 内部循环：`while (还有就绪任务 && cpu.remaining() > 0 && bucket 达标) 驱动一次 next()`。`cpu` 沿用调用方传入的同一个 `CpuBudget`，不新建准入口径；`remaining()` 已经净掉 Framework 配置的 `reserveCpu`，因此任务永远拿不到收尾预留的那部分 CPU。

### 5.2 CPU 计量

`TaskContext.used` 不需要新的原生 CPU 读数入口：`drive` 在每次 `next()` 前后各调用一次 `cpu.remaining()`，用差值算出该次分片消耗，累加后传给下一次 `next()`。这个量只服务于任务内部决定分片粒度，不代表精确的 API 级计费。

`cpu.remaining()` 内部会重新采样 `Game.cpu.getUsed()`；按建议的分片粒度（约 0.15 ms/片，见 [跨 tick 任务框架提案](../../proposals/cross-tick-tasks.md) §5.1）估算，一个用满预算的 tick 触发到低几百次采样，量级可控，但落地后应当用 Profiler 实测 `drive` 自身占用的 CPU 比例，确认采样开销没有侵蚀省下来的收益。

### 5.3 公平性

就绪任务按优先级排序；同优先级需要轮转，不是简单加一个不可变的次级键就能得到——固定次级键（例如提交序号）只会得到稳定的先到先得，跟不上"轮转"的要求。`drive` 在每次任务被驱动后更新它的次级键（记录"最近一次被驱动的轮次"），使其重新排到本优先级的末尾；[PriorityQueue](../utils/priorityQueue.md) 提供堆序，轮次维护在调度器自己的比较器里完成。

### 5.4 观测

每个任务的 Profiler 标签是 `task.<owner>.<label>`：`owner` 来自 `bind` 时的模块名，`label` 是提交时声明的分类键，两者都必须来自固定且有限的集合——这与 `PluginManifest.id`"不能按房间、任务等动态数据生成"的约束（`src/contracts/plugin.ts`）同源：Profiler 与健康表都按键长期建表，动态键会造成无界增长。按 owner 拆分标签也使 Profiler 观测的归属粒度与 §5.6 的失败归属一致，不同模块用相同的 `label` 不会在统计上互相覆盖。提交时用于去重/查询的 `id` 允许按业务拼入动态数据，但只作 owner 命名空间内的注册表键，不能直接当 `label` 使用。

### 5.5 状态与终态后的重新提交

`done`、`failed`、`cancelled`、`expired` 都不会阻止调用方按同一个 `id` 再次 `submit`；只有 `queued`/`running` 会返回原句柄。`failed`/`cancelled`/`expired` 再次提交会丢弃旧句柄并从头创建生成器；`done` 的结果在被读取之前不会被新提交覆盖，避免调用方读取时结果突然消失。`deadlineTicks` 到期标记 `expired` 并释放生成器，防止写错的任务永久占用调度器。

### 5.6 安全点、游戏对象与失败归属

任务保证每个 `yield` 处的中间数据自洽，可以在任意多个 tick 之后继续。生成器的局部变量会跨 tick 存活，因此局部变量里不能保存 `Room`、`Creep`、`Structure` 等当 tick 对象；需要时在恢复后按 id 重新取得。`RoomPosition`、地形、纯数据结构可以保留。

单个任务的生成器抛出的异常由 `drive` 自己捕获（经 ErrorMapper 的 `capture`/`mapStack` 规范化），写入该任务的 `TaskHandle.failure`，不影响其它任务。`PluginFailure.pluginId` 填任务所属的 owner（即 `bind` 时的模块名），`phase` 固定为 `'framework'`（`drive` 发生在 Framework 自己的收尾阶段，不属于任何插件的声明钩子，与该值现有定义"不属于插件的内核工作"一致）：`bind(owner)` 在提交时就确定了任务的归属，因此失败诊断天然对应发起提交的模块，不需要额外的 id 命名约定来间接表达提交者身份。

`drive` 调用本身（而不是某个任务）抛出异常，属于宿主级故障，由 Framework 用调用其它 Host（如 `MemoryHost.begin`）同等的宿主错误边界捕获：记录诊断、本 tick 跳过任务驱动，不触发 safeMode——任务调度是尽力而为的能力，不是安全关键路径。

### 5.7 硬终止与 global reset

CPU 硬终止会在任意指令处打断 `drive`，某个任务可能停在"执行中"状态，此时再次 `next()` 可能抛错。对策与项目既有做法一致：驱动前写入带 tick 归属的运行标记，下一 tick 发现标记来自旧 tick，即判定该任务被硬终止打断，默认丢弃并按 id 重新开始。**需要在私服的硬终止场景中实测确认引擎的真实行为**，再决定是丢弃还是可以继续驱动。

TaskHost 由 Runtime 组装，global reset 后随 Runtime 一起重建；生成器状态只在 heap，reset 后任务注册表为空。任务必须可重启：调用方每 tick 无条件 `submit`，同 id 幂等，reset 后自然重新开始。

## 6. 边界

- **原生调用不可切分**：`PathFinder.search`、`room.find`、市场接口等是一次性的原生调用，中途无法让出。任务只能在调用之间让出，并自行把大搜索拆成多次小搜索。
- **结果占用 heap**：未被读取的结果会一直驻留，需配合 `deadlineTicks` 与读取后释放。
- **不保证完成时间**：低 bucket 时任务会长期停摆，调用方必须容忍"暂时没有结果"。
- **强制装配不等于及时驱动**：TaskHost 属于强制装配的内核集合，不能通过 `disable`/`unregister` 卸载（见 [Core 架构](./README.md) §3），这只保证接口始终存在，不保证任务会被及时驱动——CPU/bucket 不足时行为退化为"排队但不推进"，与上一条一致。

## 7. 可选扩展：检查点（未列入首版）

任务可以在 `yield` 时交出一个可序列化的检查点，由提交者写进自己的分区，global reset 后从检查点继续。代价是每次检查点的校验与编码开销，只对"耗时以万 CPU 计"的任务值得。这属于 MemoryManager 的常规用法（调用方自己持有 `context.memory`），TaskHost 本身不需要依赖 MemoryManager，不需要新机制。

## 8. 待决设计事项

1. 首版是否包含事件通知（任务完成时发布一次 EventBus 事件），还是只提供轮询；若引入则 TaskHost 需要新增对 EventBus 的依赖。
2. 任务是否允许嵌套提交子任务（涉及优先级继承与死锁判断）。
3. 任务失败后的重试策略：交给调用方手动 `submit`，还是提供 `retry` 选项。
4. `label` 是否需要在类型层强制要求，而不是只靠约定与代码评审防止动态 id 混入 Profiler 标签。
5. `getStatus()` 的具体诊断字段。
6. Runtime 组装顺序与 `test/coreDependencyBoundary.test.ts` 的 `RUNTIME_PREDECESSORS` 集合需要在实现时加入 `taskScheduler`，依赖 Logger、ErrorMapper、Profiler。
