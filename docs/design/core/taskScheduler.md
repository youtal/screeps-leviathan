# TaskScheduler 设计

交付状态：已交付。契约类型、Runtime/Framework 接入、生成器驱动、优先级与轮转、CPU 准入（含 bucket 高水位盈余额度）与单任务每 tick 软上限、失败隔离与归属、deadline 过期、实例语义（submit 只保证实例存在、release、实时句柄、闲置回收、插件释放时回收任务）、硬终止恢复与跨 global 重启记录均已交付，由单元测试与私服集成场景 `leviathan-tasks` 覆盖。检查点扩展（§7）与 §8 的待决事项不在交付范围内。模块路径为 `src/core/taskScheduler/`，可调用能力见 [使用说明](../../usage/core/taskScheduler.md)。

## 1. 定位与目标

TaskScheduler 是 Core 的内核能力，把一段单 tick 内算不完的同步计算，用生成器分摊到多个 tick 完成。它只提供协作式调度、CPU 准入与失败隔离，不理解任务计算的具体业务含义；房间布局规划、成本矩阵构建、大范围寻路预计算等具体算法由调用方以生成器形式提供。

设计目标：

- 挂起点由任务自己在生成器里用 `yield` 显式声明，调度器只在这些点之间驱动，不尝试中断任意同步函数——JavaScript 没有抢占式调度，一个同步函数一旦开始执行，宿主代码无法在中间插入控制流或重建其栈帧、局部变量与闭包引用。
- 归属清晰：任务在谁的上下文里提交，失败诊断就归属谁，不需要额外的 id 命名约定来间接表达提交者身份；提交者被释放时，它的任务随之释放。
- 只用空闲的 CPU：任务使用本 tick 常规额度中插件没有用完的部分，以及 bucket 高于水位的盈余，不把 tick 推向硬上限。
- 与既有内核能力对齐：CPU 判断复用 `CpuBudget`、故障记录复用 `PluginFailure`、计时复用 Profiler、生命周期恢复复用 global reset 的既有约定，不新造一套准入或诊断口径。

## 2. 为什么是内核能力

TaskScheduler 不理解房间、建筑、寻路等游戏领域概念，纯粹是脚本基础设施，这与 Logging、EventBus、Profiler、ErrorMapper、MemoryManager 的定位一致（见 [Core 架构](./README.md) §2）。

它的驱动时机也不适合套用普通插件模型：调度需要在所有普通插件的 tickExecute、Intent 仲裁、tickEnd 与 Memory 收尾都完成后，用剩余的 CPU 驱动，而不是作为参与拓扑排序、可被 `disable`/熔断的普通插件之一。把“最后一个拿 CPU”这件事建立在插件优先级这种可被其它插件的注册顺序或依赖关系影响的弱约束上并不合适；做成 Runtime 直接组装的内核能力，驱动时机由 Framework 在自己的 loop 尾部显式调用，由 Kernel 保证而不是依赖约定。

TaskScheduler 依赖 Logger（自身诊断）、ErrorMapper（任务失败的堆栈捕获与映射）、Profiler（任务分片计时）与 MemoryHost（跨 global 重启记录，见 §5.8），在 Runtime 中排在它们之后创建；对 MemoryManager 只经 `MemoryHost` 契约申请一个分区，不提供任务自身的跨 tick 检查点（§7）。不依赖 EventBus。

## 3. 对外协议

### 3.1 任务体、句柄与调度入口

```ts
/** 任务体：收到上下文，返回一个在安全点 yield 的生成器。是函数，不是生成器对象。 */
type TaskBody<T> = (context: TaskContext) => Generator<void, T, void>;

interface TaskContext {
  /** 当前 tick；每次恢复都会更新，任务不要自己缓存 tick。 */
  readonly tick: number;
  /** 本任务在本 tick 已完成分片的累计 CPU，不含正在执行的一片；见 §5.3。 */
  readonly used: number;
}

/** 任务实例的实时句柄；同一实例的 submit/get 返回同一个对象，见 §5.6。 */
interface TaskHandle<T> {
  readonly id: string;
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
  /** state 为 done 时有效。 */
  readonly result?: T;
  /** state 为 failed 时给出结构化故障，与插件故障同构；归属规则见 §5.7。 */
  readonly failure?: PluginFailure;
  /** 停止活跃实例（变为 cancelled）；实例保留，终态时为空操作。 */
  cancel(): void;
}

/** 只在创建实例时生效。 */
interface TaskOptions {
  /** 调度优先级，大者先获得 CPU；缺省 0。 */
  priority?: number;
  /** 从实例创建起的存活上限（tick 数），超过即 expired 并释放生成器。 */
  deadlineTicks?: number;
  /** 低于该 bucket 时不驱动；缺省取 defaultMinBucket。 */
  minBucket?: number;
  /** 本任务每 tick 的 CPU 软上限；缺省取 defaultMaxCpuPerTick（不限）。见 §5.4。 */
  maxCpuPerTick?: number;
  /**
   * Profiler 标签使用的分类键，必须来自固定且有限的集合（与 PluginManifest.id 的约束同源，
   * 见 §5.5）。缺省回退到 id 本身；调用方一旦按业务动态拼接 id（例如按房间区分任务实例），
   * 必须显式提供固定的 label。
   */
  label?: string;
}

/** 每个模块拿到的、已绑定 owner 的调度入口；见 §4。 */
interface TaskScheduler {
  /** 确保实例存在：同 id 已有实例（任何状态）时返回它，否则从 body 创建。见 §5.6。 */
  submit<T>(id: string, body: TaskBody<T>, options?: TaskOptions): TaskHandle<T>;
  /** 查询实例；从未提交、已 release 或已被回收时为 undefined。 */
  get<T>(id: string): TaskHandle<T> | undefined;
  /** 释放实例（活跃的先取消）；之后的 submit 重新创建。 */
  release(id: string): void;
}
```

### 3.2 宿主端口

Runtime 组装、Framework 驱动的生命周期端口，形态对齐 [MemoryHost](../contracts.md)：

```ts
interface TaskHost {
  /** 按 owner（模块名/插件 id）派生绑定后的调度入口；构造与 bind 不产生调度副作用。 */
  bind(owner: string): TaskScheduler;
  /** Framework 在 MemoryHost.end 之前调用一次，写入跨 global 重启记录；见 §5.8。 */
  persist(tick: number): void;
  /** Framework 在本 tick 收尾的最后阶段调用一次；见 §5.1、§5.2。 */
  drive(tick: number, cpu: CpuBudget): void;
  /** 释放 owner 名下的全部实例；Framework 在释放插件时调用，见 §5.6。 */
  releaseOwner(owner: string): void;
  /** 最小诊断快照：活跃实例中排队与运行中的数量。 */
  getStatus(): { queued: number; running: number };
}
```

`CoreRuntime` 包含 `readonly tasks: TaskHost`；`ModuleContext` 包含 `tasks?: TaskScheduler`（可选原因与 `memory?: ApplyMemoryAccessor` 一致：允许测试替身或特殊宿主构造不含调度能力的上下文）。`createContext` 内部调用 `taskHost.bind(moduleName)` 填充该字段，模块不自己调用 `bind`。模块名与插件 id 共用同一个 owner 命名空间，owner 不能为空。

### 3.3 配置

调度器配置经 `RuntimeOptions.taskScheduler` 传入；`getGame`、`logging`、`errorMapper`、`profiler`、`memory` 由 Runtime 注入，不能从配置覆盖。

| 配置 | 缺省 | 含义 |
| --- | --- | --- |
| `defaultMinBucket` | 5000 | 任务未声明 `minBucket` 时的 bucket 门限 |
| `defaultMaxCpuPerTick` | 不限 | 任务未声明 `maxCpuPerTick` 时的每 tick 软上限 |
| `retainTicks` | 1000 | 实例连续多少 tick 未被 `submit`/`get` 触碰即被回收；上一 global 留下的无人认领记录按同一期限清理；不限表示不按闲置回收 |
| `burstBucket` | 9500 | bucket 达到该值时允许使用高于水位的盈余（§5.2）；不限表示关闭 |

## 4. 消费方式

业务钩子直接从 `context.tasks` 取得已绑定的调度入口，不经过 `manifest.requires`/`services.get`——这与 `context.memory`、`context.cpu` 是同一种接入方式：TaskScheduler 是内核能力而不是可选服务，所有模块的上下文里都直接可用。

```ts
onTickExecute(context) {
  if (plans.has('W1N1')) return;              // 结果已保存，不再提交
  const plan = context.tasks.submit('layout:W1N1', () => planLayout('W1N1'), {
    priority: 5,
    label: 'layout', // 固定分类键；'W1N1' 只出现在 id 里，不进入 Profiler 标签。
  });
  if (plan.state === 'done') {
    plans.save('W1N1', plan.result!);
    context.tasks.release('layout:W1N1');
  }
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

`id` 只需要在同一 owner 内唯一——`bind(owner)` 已经把不同模块的任务隔离在各自的命名空间，不同插件用相同的 `id` 不会互相冲突。owner 与 id 都要能用作 MemoryManager 的字符串路径段，且不得包含注册键分隔符 NUL：入口校验它们是否为非空字符串，并拒绝 `__proto__`、`prototype`、`constructor` 与 NUL。校验在创建实例之前完成，避免任务运行却无法保存重启记录，且保证不同 `(owner, id)` 不会拼出相同的注册键。

## 5. 调度、归属与恢复

### 5.1 驱动时机

Framework 在一个 tick 内的既有时序（[Framework 设计](./framework.md) §4）之后追加一步：

```text
tickBegin → tickExecute(plan → arbitrate → commit) → tickEnd（逆序）
→ 健康/熔断统计 → TaskHost.persist(tick) → MemoryHost.end → TaskHost.drive(tick, cpu)
```

`persist` 在 Memory 写入阶段内登记本 tick 新建的实例、删除已结束实例的记录（§5.8）；没有待处理记录时不申请分区、不标脏。

`drive` 严格排在 `MemoryHost.end` 之后：任务只做计算、不提交意图，与 Memory 提交没有依赖关系；排在最后可以保证任务调度不会挤占插件收尾、健康统计或 Memory 持久化所需的 CPU。safeMode 为真的 tick 直接跳过 `drive`，与 tickExecute/commit 阶段一致：正常业务都被中止时，不再做这类更低优先级的机会性工作。

`drive` 先做一次清扫（闲置回收、deadline 过期、硬终止恢复，见 §5.6、§5.8），再从活跃且 bucket 达到各自 `minBucket` 的实例建立就绪队列，循环 `while (队列非空 && cpu.admit()) 驱动一片`。

### 5.2 CPU 口径

每开始一片前调用调用方传入的 `cpu.admit()`，即 Framework 对普通插件的准入口径：bucket 达到 Framework 的 `minBucket`，且已用 CPU 低于常规额度 `limit` 减 `reserveCpu`。`cpu` 沿用驱动本轮插件的同一个 `CpuBudget`，不新建准入口径。

由此得到三条性质：

- **主要使用空闲额度**：任务使用的是本 tick 常规额度中插件没有用完的部分。bucket 已满时，这部分 CPU 本来就会被浪费；bucket 未满时，任务运行期间 bucket 每 tick 只回升 `reserveCpu`。任务缺省的 `minBucket`（5000）高于 Framework 缺省门限，bucket 低于它时任务暂停，bucket 以全部空闲额度回升。
- **估算偏差由 bucket 承担**：`admit()` 只能在开始一片前判断，分片本身可能超出剩余额度。超出部分从 bucket 扣除；bucket 健康时 `limit` 与 `tickLimit` 之间有数百 CPU 的余量，只有单个分片独自越过 `tickLimit` 才会触发硬终止，这类失控分片由 §5.8 的重启上限兜底。
- **吞吐取决于插件留下的余量与 bucket 盈余**：一个 2000 CPU 的规划任务在每 tick 余量 5 CPU 时约需 400 tick；bucket 高于水位时还可以使用盈余额度加快。

**盈余额度**：`admit()` 拒绝后，若本 tick 开始时 bucket 不低于 `burstBucket`（缺省 9500），仍可继续开始新的一片，条件是已用 CPU 低于 `limit + min(bucket − burstBucket, limit)`，且 `cpu.remaining()` 大于 100（与 `tickLimit − reserveCpu` 保持 100 CPU 的距离）。三条约束各有用途：只花高于水位的部分，本 tick 结束后 bucket 仍不低于水位；每 tick 至多再用一份常规额度，盈余分摊到多个 tick，单 tick 的 CPU 不会陡增；与硬上限保持距离，limit 较高的账号也不会因稍大的分片越过 `tickLimit`。有积压任务时，bucket 因此维持在水位附近而不再回满（官方服务器生成 pixel 需要满 bucket）；`burstBucket` 设为不限即关闭。

建议单个分片控制在 1 CPU 以内；按 [跨 tick 任务框架提案](../../proposals/cross-tick-tasks.md) §5.1 的实测，约 0.15 ms 的分片已能让调度开销落在噪声范围内。

### 5.3 CPU 计量

每片前后各读一次 `Game.cpu.getUsed()`，差值累加到本任务本 tick 的消耗；换 tick 后首次驱动时清零。这个量用于 `TaskContext.used` 与 §5.4 的单任务上限，不代表精确的 API 级计费。

`TaskContext.used` 只在每次恢复前更新，同一分片内部读到的是同一个值，因此只能用来决定下一片的粒度，不能在分片内部当作循环条件。

每一片的调度开销包括一次 `admit()`（两次 `getUsed` 采样）、前后两次 `getUsed` 采样、一次错误边界与一次 Profiler 包装（开启 Profiler 时另有两次采样）。在 Node 24 中对打包产物测量，每片调度开销约 0.16 µs（1 个任务）到 0.22 µs（50 个任务），开启 Profiler 约 0.27 µs，按 0.15 ms 的分片约占 0.1%；`getUsed` 在官方运行时中的单次成本仍需用 Profiler 在真机上确认。

### 5.4 公平性与单任务上限

就绪任务按优先级排序，同优先级轮转。固定次级键（例如提交序号）只会得到稳定的先到先得，跟不上“轮转”的要求；`drive` 在每次任务被驱动后更新它的次级键（记录“最近一次被驱动的轮次”），使其重新排到本优先级的末尾。[PriorityQueue](../utils/priorityQueue.md) 提供堆序，轮次维护在调度器自己的比较器里完成。轮转以分片为单位，分片越大的任务在同优先级中得到的 CPU 越多。

`maxCpuPerTick` 是单个任务每 tick 的软上限：本 tick 累计消耗达到上限后，该任务本 tick 不再入队；正在执行的一片不会被打断，因此最多超出一片的消耗。被限住的 CPU 继续分给队列中的其他任务（包括更低优先级的任务），只有所有活跃任务都达到上限时剩余额度才不被使用。缺省不限：总量已由 §5.2 限制在空闲额度内，默认再对单个任务设限只会让“只有一个任务”的常见情形白白让出 CPU。

### 5.5 观测

每个任务的 Profiler 标签是 `task.<owner>.<label>`，在创建实例时拼好：`owner` 来自 `bind` 时的模块名，`label` 是提交时声明的分类键，两者都必须来自固定且有限的集合——这与 `PluginManifest.id`“不能按房间、任务等动态数据生成”的约束（`src/contracts/plugin.ts`）同源：Profiler 与健康表都按键长期建表，动态键会造成无界增长。按 owner 拆分标签也使 Profiler 观测的归属粒度与 §5.7 的失败归属一致，不同模块用相同的 `label` 不会在统计上互相覆盖。提交时用于查询的 `id` 允许按业务拼入动态数据，但只作 owner 命名空间内的注册表键，不能直接当 `label` 使用。

### 5.6 实例语义

- **submit 只保证实例存在**：同 id 已有实例时，无论处于活跃状态还是终态都返回它，本次传入的 `body`/`options` 被忽略；只有不存在实例时才从 `body` 创建。因此调用方可以每 tick 无条件 `submit`：已完成的结果不会被重算，失败与过期保持可见，不会被自动重试。
- **release**：释放实例（活跃的先取消）并从注册表移除。重算或失败后重试由调用方决定时机，先 `release` 再 `submit`。
- **cancel**：停止活跃实例（变为 `cancelled`）并释放生成器，实例本身保留，直到被释放或回收。
- **实时句柄**：句柄的 `state`/`result`/`failure` 是读取实例当前状态的访问器，同一实例的 `submit`/`get` 返回同一个对象。实例被释放后句柄停在最后的状态（活跃时被释放即为 `cancelled`），不会指向之后按同一 id 新建的实例。
- **闲置回收**：实例连续 `retainTicks` 个 tick 没有被 `submit`/`get` 触碰即被回收（活跃的先取消）。这回收了没人读取的结果，以及不经 Framework 生命周期管理的普通模块留下的任务；按推荐方式每 tick 轮询的实例不受影响。
- **随插件释放**：Framework 释放插件（停用、熔断、卸载、替换或 setup 失败）时调用 `releaseOwner(pluginId)`，已释放插件的任务不再消耗 CPU，替换后的新实例也不会拿到旧实例留下的任务。该调用经 Framework 的宿主错误边界执行，异常按框架故障记录。
- **deadline**：`deadlineTicks` 从实例创建起计算，到期标记 `expired` 并释放生成器，防止写错的任务永久占用调度器。
- **终态释放任务体**：实例进入终态即释放生成器与 `body`，尽快放掉其闭包持有的引用；结果或故障仍可读取。

### 5.7 安全点、游戏对象与失败归属

任务保证每个 `yield` 处的中间数据自洽，可以在任意多个 tick 之后继续。生成器的局部变量会跨 tick 存活，因此局部变量里不能保存 `Room`、`Creep`、`Structure` 等当 tick 对象；需要时在恢复后按 id 重新取得。`RoomPosition`、地形、纯数据结构可以保留。

`drive` 位于 `MemoryHost.end` 之后，Kernel 此时的执行归属是 `framework`、阶段是 `tasks.drive`：任务体内写入或申请 Memory 分区会被 MemoryManager 拒绝，提交意图、订阅、发布服务或经插件上下文发布事件会被 Framework 拒绝，异常使该任务失败。绕过插件上下文、经 `runtime.bus` 在 `drive` 期间发布的事件不投递给插件订阅者，每种事件告警一次：此时 Memory 已经提交、健康统计已经结束，订阅者在这里运行既写不了分区，失败也不会计入熔断。需要持久化的结果或需要通知其他模块的事件，由提交者在自己的钩子里读取句柄后处理（§7 的检查点同理）。

单个任务的生成器抛出的异常由 `drive` 自己捕获（经 ErrorMapper 的 `capture`/`mapStack` 规范化），写入该任务的 `TaskHandle.failure`，不影响其它任务。`PluginFailure.pluginId` 填任务所属的 owner（即 `bind` 时的模块名），`phase` 固定为 `'framework'`（驱动发生在 Framework 自己的收尾阶段，不属于任何插件的声明钩子，与该值“不属于插件的内核工作”的定义一致）：`bind(owner)` 在提交时就确定了任务的归属，因此失败诊断天然对应发起提交的模块。失败的实例保留，直到调用方 `release`，同一次失败只报告一次。

`drive` 调用本身（而不是某个任务）抛出异常，属于宿主级故障，由 Framework 的宿主错误边界捕获，诊断阶段为 `'tasks.drive'`：记录诊断、本 tick 不再驱动任务，不触发 safeMode——任务调度是尽力而为的能力，不是安全关键路径。

### 5.8 硬终止与 global reset

CPU 硬终止会在任意指令处打断 `drive`，某个任务可能停在“执行中”状态，此时再次 `next()` 会抛错。每片执行前写入运行标记、执行后清除；下一次 `drive` 发现标记仍在，即判定该任务上一片被硬终止打断。`drive` 每 tick 至多调用一次，布尔标记已足以区分“上一次被打断”，不需要记录 tick。

清扫按以下顺序处理每个实例：

1. 闲置回收（§5.6）；
2. deadline 过期：先于硬终止恢复判断，反复被中断的任务同样按期过期；
3. 硬终止恢复：同一实例最多按 `body` 重启 1 次，重建在错误边界内进行——`body` 可能读取已经失效的游戏状态而抛错，异常只让该任务失败，不能逃出清扫拖垮全部任务；第 2 次被中断即以 `failed` 结束，`failure.message` 注明被硬终止中断的次数。

在 §5.2 的口径下，`drive` 中的硬终止意味着单个分片独自越过了 `tickLimit`，几乎总是分片内死循环或一次过大的原生调用，重来通常会再次失败；只重启一次，避免失控任务每 tick 触发一次硬终止。私服集成场景 `leviathan-tasks` 实测：分片内死循环被引擎终止后 heap 保留，任务按 `body` 重启一次、再次被终止后以 `failed` 结束，Framework 不进入 safeMode；终止所在 tick 已由 `MemoryHost.end` 提交的分区数据已经落盘。

TaskHost 由 Runtime 组装，global reset 后随 Runtime 一起重建；生成器状态只在 heap，reset 后任务注册表为空。任务必须可重启：调用方每 tick 无条件 `submit`，reset 后自然重新开始。

**跨 global 重启记录**：官方服务器可能在硬终止后重建 isolate，注册表与运行标记随之丢失，调用方重新提交后同一个分片会再次触发硬终止。`drive` 位于 `MemoryHost.end` 之后，分片执行期间无法写入存储，也就无法记录“哪个任务正在执行”；调度器因此记录更粗的事实——实例存续期间经历了几次 global reset：

- 记录保存在内核保留 owner `framework` 下的分区 `tasks`（Framework 拒绝以 `framework` 作插件 id，普通模块名也不应使用它），结构为 owner → 任务 id → 已经历的 reset 次数。
- 实例创建后的第一次 `persist` 登记它：若分区中已有同键记录（即上一 global 结束时该任务仍存续），次数为旧值加一，否则为 0。实例以任何终态结束、被 `release`、被闲置回收或随插件释放时，记录在下一次 `persist` 删除。
- 登记时次数超过 2（即连续第 3 次 reset 仍未完成）的实例直接以 `failed` 结束（此时它尚未被驱动，`persist` 位于 `drive` 之前），`failure.message` 注明经历的 reset 次数，同时删除记录：之后的 reset 给它新的机会，修复任务体并重新部署后自动恢复；未修复时，每次无关的 reset 最多再引发 3 次硬终止。
- 每次 reset 都会让任务从 `body` 重新开始，连续 3 次 reset 仍未完成的任务要么在反复拖垮 global，要么在当前的 reset 频率下根本跑不完，以 `failed` 暴露给调用方比无限重来更合适。该判定无法区分是哪一个任务导致了重建：同一时段存续、且因排在后面而一直没被驱动的其他任务也会计数；需要跨越多次 reset 的长任务应当使用检查点（§7）。
- 记录只用路径写入：owner 与任务 id 在入口已按路径段规则校验。分区不可用、首次读取或单条路径操作失败时只告警，保留尚未完成的登记、删除与孤儿清理，下一次 `persist` 重试；登记成功后才消费上一 global 的计数。其余任务照常运行。上一 global 留下、本 global 在 `retainTicks` 内无人认领的记录会被清理；本 global 从未使用任务时分区保持原样。
- 实例的创建与结束会让该分区在当 tick 或下一 tick 变脏一次，长期运行的实例不产生写入。

私服集成场景 `leviathan-tasks` 以 Memory 快照启动新世界（等价于一次 global reset），实测存续实例的记录由 0 变为 1。

## 6. 边界

- **原生调用不可切分**：`PathFinder.search`、`room.find`、市场接口等是一次性的原生调用，中途无法让出。任务只能在调用之间让出，并自行把大搜索拆成多次小搜索。
- **结果占用 heap**：实例连同结果保留到 `release`、闲置回收或随插件释放。
- **不保证完成时间**：插件留下的余量少、bucket 低于门限或被更高优先级任务占用时，任务会长期停摆，调用方必须容忍“暂时没有结果”。
- **强制装配不等于及时驱动**：TaskHost 属于强制装配的内核集合，不能通过 `disable`/`unregister` 卸载（见 [Core 架构](./README.md) §3），这只保证接口始终存在，不保证任务会被及时驱动。
- **任务体只做计算**：不能写 Memory、不能提交意图、不能发布事件，见 §5.7。
- **跨 global 判定是启发式的**：只统计实例存续期间经历的 reset 次数，无法定位是哪个任务导致了重建，见 §5.8。

## 7. 可选扩展：检查点（未交付）

任务可以在 `yield` 时交出一个可序列化的检查点，由提交者写进自己的分区，global reset 后从检查点继续。代价是每次检查点的校验与编码开销，只对“耗时以万 CPU 计”的任务值得。这属于 MemoryManager 的常规用法（调用方自己持有 `context.memory`），不需要调度器提供新机制；§5.8 的重启记录只保存次数，不保存任务状态。

## 8. 待决设计事项

1. 是否提供完成事件（任务完成时发布一次 EventBus 事件），还是只提供轮询；若引入则 TaskHost 需要新增对 EventBus 的依赖。
2. 任务是否允许嵌套提交子任务（涉及优先级继承与死锁判断）。未决定前，在 `drive` 中提交的任务从下一 tick 开始驱动，没有父子关系。
3. `label` 是否需要在类型层强制要求，而不是只靠约定与代码评审防止动态 id 混入 Profiler 标签。
