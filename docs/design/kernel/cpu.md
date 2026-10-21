# 模块设计：cpu（分层准入与预算）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/kernel/cpu/` |
| 架构章节 | 5.2 CPU 分层与准入、5.3 CPU 预算、附录 B（收尾预留、`BUCKET_TARGET`、`BUCKET_DRAIN`、规划层 bucket 阈值） |
| 契约 | [contracts](../contracts/README.md) 第 4 节的 `Tier`、`CpuBudget`，不变 |
| 成熟度 | 定稿 · M1；殖民地份额与实例准入过滤 `admit` 在 M2 随 colony 加入（5.2、[contracts](../contracts/README.md#7-待加入的接口)） |

## 1. 职责与范围

kernel.cpu 回答两件事：本 tick 哪些进程运行（准入），以及每个进程还能花多少 CPU（`CpuBudget`）。它在 tick 开始时计算预算并做一次准入，阶段执行期间计量每个进程的耗用，tick 结束时更新平滑耗用。

M1 实现 5.2、5.3 中与殖民地无关的部分：

| 规则 | M1 | 说明 |
| --- | --- | --- |
| 每 tick 预算 B 与透支额 | 实现 | 5.3 的公式 |
| 收尾预留 | 实现 | B 的 10%，至少 2 CPU |
| 四层准入条件 | 实现 | 维护层的周期错峰使用 [lib.hash](../lib/hash.md) |
| 预计耗用预检、"放不下的下一 tick 优先" | 实现 | 以进程的平滑耗用为预计值 |
| 平滑计量 | 实现 | 供准入预检、stats 与 `ops.status()` |
| 殖民地份额、姿态优先级、`admit` 过滤 | M2 | 依赖 colony；M1 各层共用一个份额 |

M1 没有业务模块，被准入的只有生存层的 boot；kernel 自身的收尾任务不参与准入（第 3.3 节）。规则按完整进程表设计，以单元测试验证，M2 加入业务模块时不改变机制。

## 2. 预算

每 tick 在 tick 起点计算一次（boot 之前，boot 的 `ctx.cpu` 也使用它）；准入在 boot 与普通模块 setup 之后、业务阶段之前执行（第 3 节）：

```text
B        = Game.cpu.limit + clamp((bucket − BUCKET_TARGET) / BUCKET_DRAIN, −limit × 0.2, tickLimit − limit)
R        = max(2, B × 0.1)                         收尾预留：供 move 与 commit
poolEnd  = B − R                                   经济、维护、规划层的 CPU 读数上限
hardEnd  = tickLimit − R                           生存层的 CPU 读数上限
```

- 两个上限都是 `Game.cpu.getUsed()` 的绝对读数，而不是增量：boot、setup 与准入本身的耗用自然计入。
- **生存层**"总是准入，但不越过收尾预留"：生存层不受 B 约束，可以动用 bucket，但读数到达 `hardEnd` 后同样让出。
- 私服的 `Game.cpu.limit` 与 `tickLimit` 按游戏给出的值计算，不另设特例。

## 3. 准入

### 3.1 准入单位

准入的单位是进程：静态模块与动态实例各自准入。实例与所属模块的关系按依赖处理：所属模块落选时实例同样落选，所属模块空闲（例如维护层周期未到）时实例仍可准入（第 3.2 节）。boot 不参与准入：它在准入之前运行，生存层总是运行，它的耗用体现在准入时的当前读数中。

### 3.2 准入流程

每 tick 一次，在业务阶段开始前执行；结果在本 tick 内固定。

```text
expected = 当前读数 + 生存层全部可运行进程的平滑耗用之和
对 economy、maintenance、planning 三层依次：
  候选顺序：连续落选次数大于 0 的进程在前（从多到少），其余按执行顺序
  对每个候选执行 judge；每个进程每 tick 只判定一次，结果为"准入""空闲""落选"之一

judge(p)：
  已判定 → 返回已有结果
  层条件不满足 → 空闲（本 tick 本来就不运行，不计落选）
  先 judge p 的所属模块（p 为实例时）与同层的 requires 模块；
    任一为"落选" → 落选，连续落选次数 +1
  expected + 预计耗用 ≤ poolEnd → 准入，expected += 预计耗用（连续落选次数在 settle 确认仍为准入时归零）
  否则 → 落选，连续落选次数 +1，预计耗用 ← 预计耗用 × (1 − CPU_EMA_ALPHA)
```

结果的含义：

| 结果 | 本 tick | 对依赖方 |
| --- | --- | --- |
| 准入 | 运行全部阶段 | 不阻挡 |
| 空闲 | 不运行；层条件不满足，例如维护层周期未到 | 不阻挡 |
| 落选 | 不运行；预算放不下，或所属模块、同层依赖落选 | 阻挡：依赖方同样落选 |

| 层 | 层条件 |
| --- | --- |
| 生存 | 无，总是准入 |
| 经济 | 无 |
| 维护 | `(Game.time + hashString(进程键)) % MAINTENANCE_PERIOD === 0` |
| 规划 | `bucket ≥ PLANNING_BUCKET`（1500） |

- **执行顺序不变**：准入只决定谁运行，不改变拓扑顺序。落选进程的"优先"体现在下一 tick 的判定次序中，它们先占用预算。
- **先判定依赖**：落选者排在前面时，它的所属模块或同层依赖可能还没判定，所以 judge 先递归判定它们。每个进程只判定一次，总成本仍为 O(进程数)。依赖成环已被清单校验拒绝，递归必然终止。跨层依赖无需递归：`requires` 只能指向同层或更高的层，而更高的层先判定，生存层总是准入。
- **依赖的含义**：依赖方被阻挡，只在依赖本 tick 因预算或其自身的依赖"落选"时发生。依赖"空闲"时不阻挡：维护层的模块与它的实例、同层的两个模块都按各自的进程键错峰，相位一般不同，若要求依赖必须在同一 tick 运行，依赖方只会在相位重合的 tick 运行。`requires` 关于熔断、初始化失败与运维暂停的传递（[内核设计](./README.md#33-错误边界与熔断)）不变，这些进程本来就不参与准入。
- **落选时衰减预计值**：按剩余预算自适应的长计算（一直运行到 `shouldYield()`）的样本，反映的是运行时还剩多少预算，而不是它至少需要多少。预算收缩后，它的预计值可能永远放不下；而不运行就不会产生新样本。因此每次因预算落选都把预计值乘以 `1 − CPU_EMA_ALPHA`，连续落选数 tick 后必然放得下，运行后再由实际样本校正。昂贵的进程因此会周期性地重试，重试时仍受 `shouldYield` 与紧急刹车约束。因依赖落选时不衰减：此时放不下的不是它自己。
- **准入在整个 tick 内有效**：被准入的进程运行全部五个阶段。阶段之间不重新准入，否则会出现 plan 已经登记、act 却不执行的半途状态。
- **紧急刹车**：阶段执行中读数到达 `hardEnd` 时，本 tick 剩余的非生存层钩子全部跳过，保证收尾阶段的预留。只有预计值严重偏低（例如 global reset 后的首次运行）才会触发；被跳过的进程不计失败，改记为落选：本 tick 不记样本、不计准入，连续落选次数加 1，下一 tick 优先判定；预计值不衰减，放不下的是本 tick 的整体读数而不是它自己。被跳过前已运行的阶段的耗用仍计入层耗用。若把被跳过的进程当作以 0 为样本的准入，它的预计值会一路下降、每 tick 被准入又被刹车，连续落选次数却始终为 0，可以无限期不运行。
- **预热**：没有平滑耗用的进程（global reset 后或新添加）预计值按 0 计，总是准入，首次运行即得到样本。长计算本身受 `shouldYield` 约束，不会因为预计值偏低而越过上限。
- **暂停与熔断**：运维暂停（[ops](../app/ops.md)）、熔断与初始化失败的进程不参与准入，也不累计落选次数。

### 3.3 kernel 自身的任务

| 任务 | 层 | 准入 |
| --- | --- | --- |
| Memory 维护 `maintain()` | 收尾 | 不参与准入，每 tick 调用一次，以每 tick 的记录上限（默认 50）约束单次成本，消耗收尾预留 |
| Memory 提交 `commit()`、segment 提交 | 收尾 | 不参与准入，消耗收尾预留 |
| stats 采集与写出 | 收尾 | 不参与准入；写出频率由 [stats](./stats.md) 规定 |

Memory 维护不归入维护层：维护层的定义是"每 N tick 一次，按进程键错峰"（5.2），而 Memory 维护本身已按记录数分批，每 tick 只做一小份，按维护层的周期运行只会让回收延迟扩大 N 倍，不减少总工作量。它与提交同属 kernel 的收尾工作，单次成本有上限，计入收尾预留。

## 4. CpuBudget

契约不变。每个进程的上下文持有其层级对应的视图：

| 层 | `remaining()` | `shouldYield()` |
| --- | --- | --- |
| 生存 | `hardEnd − 当前读数` | `remaining() ≤ 0` |
| 经济、维护、规划 | `poolEnd − 当前读数` | `remaining() ≤ 0` |

- 同层的进程共用一个份额。M2 的殖民地份额会把非生存层的 `poolEnd` 细分到殖民地，接口不变。
- 读数取 `Game.cpu.getUsed()`。每次调用都有成本，`shouldYield` 应每处理一批调用一次，而不是每个元素一次（contracts 第 4 节）。

## 5. 计量

- **样本**：进程在本 tick 所有阶段钩子耗用之和。每个阶段开始时读一次 `Game.cpu.getUsed()`，之后相邻两次钩子调用之间只读一次：前一个钩子的结束读数就是后一个的开始读数，差值计入前一个进程的 `spent`。
- **与 profiler 共用开始读数**：模块钩子仍按标签计时（[profiler](./profiler.md)），但只调用 `end(op, start)`，开始读数复用上一条的读数；profiler 的 `end` 自己再读一次。所以每次模块钩子调用共两次读数，实例钩子在不单独计时（`profileInstances` 为 false，默认）时一次。
- **平滑**：`cost ← cost + CPU_EMA_ALPHA × (样本 − cost)`，首个样本直接作为初值。`cost` 就是准入时的预计耗用。本 tick 没有运行的进程没有样本；其中因预算落选的，按第 3.2 节衰减 `cost`；被紧急刹车跳过的同样没有样本，`cost` 不变。
- **用途**：准入预检的预计值；stats 写出各层耗用与耗用最高的进程（[stats](./stats.md)）；`ops.status()` 显示。
- profiler 仍按标签聚合计时，用于诊断；cpu 的计量独立于它，关闭 profiler 不影响准入。

## 6. 状态与成本

- 每个进程的运行记录增加以下字段：可运行状态 `runnable`（准入前由 lifecycle 计算）、平滑耗用 `cost` 与是否已有样本 `sampled`、连续落选次数 `starve`、本 tick 的判定结果 `verdict`（未判定、准入、空闲、落选）、本 tick 已计量的耗用 `spent`。只存于 heap，global reset 与软重置后从预热开始。
- 每 tick 的固定成本：准入遍历一次可运行进程，为 O(进程数)；维护层的错峰相位 `hashString(进程键) % MAINTENANCE_PERIOD` 在进程记录创建时算一次（`maintenancePhase`），准入时只做一次加法与取模。阶段执行中每个阶段一次、每次钩子调用一次 `getUsed()`（模块钩子另有 profiler 的一次，第 5 节）。准入每 tick 重建一次进程列表，数组跨 tick 复用。
- 每 tick 一次的预算计算读取 `limit`、`tickLimit` 与 `bucket`。

## 7. 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `BUCKET_TARGET` | 5000 | 附录 B |
| `BUCKET_DRAIN` | 1000 tick | 附录 B，透支回落时长 |
| 收尾预留 | B 的 10%，至少 2 CPU | 附录 B |
| `PLANNING_BUCKET` | 1500 | 附录 B，规划层 bucket 阈值 |
| `MAINTENANCE_PERIOD` | 10 tick | 维护层进程的执行周期；按进程键错峰 |
| `CPU_EMA_ALPHA` | 0.2 | 平滑系数，约 5 个样本收敛 |

`MAINTENANCE_PERIOD` 与 `CPU_EMA_ALPHA` 是本模块的参数，M2 实测后与 5.3 的目标值一起校准。

## 8. 与其他模块的关系

| 模块 | 关系 |
| --- | --- |
| kernel.lifecycle | 在 boot 与 setup 之后调用准入；阶段循环只调用被准入的进程，并在钩子之间读数计量；读数到达 `hardEnd` 时停止非生存层；收尾后更新平滑耗用；tick 起点调用 `beginTick`（[内核设计](./README.md#2-tick-流水线)第 2 节） |
| kernel.context | 运行记录（`ModuleRuntime`、`InstanceRecord`）增加计量字段；上下文的 `cpu` 改为本模块提供的视图 |
| kernel.stats | 读取各层耗用、准入与落选计数、平滑耗用最高的进程 |
| app.ops | `ops.status()` 显示每个进程的平滑耗用与连续落选次数 |

## 9. 接口与用法

kernel 内部接口，只由 kernel.lifecycle 与 kernel.context 使用，不进入 contracts：

```ts
createCpu(port: CpuPort): CpuHost          // CpuPort：time、cpuUsed、limit、tickLimit、bucket；GamePort 满足

interface CpuHost {
  readonly budgets: Record<Tier, CpuBudget>; // 按层级的预算视图，注入到进程上下文
  beginTick(): void;                         // tick 起点：计算 B、R、poolEnd、hardEnd
  admit(nodes: readonly CpuNode[]): void;    // 判定全部进程；nodes 为执行顺序，不可运行的进程判为空闲
  brake(node: CpuNode): void;                // 紧急刹车跳过的进程改记为落选，连续落选次数加 1
  settle(nodes: readonly CpuNode[]): void;   // 以 spent 更新平滑耗用，汇总各层耗用；仍为准入的进程连续落选次数归零
  hardEnd(): number;                         // 紧急刹车的读数上限
  summary(): CpuTickSummary;                 // 预算、预留、各层耗用、准入与落选数
}
```

- `CpuNode` 由 `ModuleRuntime` 与 `InstanceRecord` 实现：`key`、`phase`（维护层错峰相位，构造时由 `maintenancePhase(key)` 算出）、`tier`、`owner`、`deps`、`runnable`，以及计量字段 `cost`、`sampled`、`starve`、`verdict`、`spent`。lifecycle 在 admit 前计算 `runnable`，在阶段循环中累加 `spent`，并对被紧急刹车跳过的进程调用 `brake`。
- 判定结果为常量 `VERDICT_NONE`、`VERDICT_ADMIT`、`VERDICT_IDLE`、`VERDICT_REJECT`。本 tick 新增的实例为 `VERDICT_NONE`，lifecycle 按预热规则让它运行。
- 业务模块只经 `ctx.cpu`（`CpuBudget`）使用本模块：长计算每处理一批调用一次 `shouldYield()`，为 true 时保存游标并返回。

## 10. 验证

单元测试以假 `GamePort` 驱动：B 与透支额的边界（bucket 高、低、等于目标）；收尾预留的下限；四层的层条件（维护层错峰、规划层 bucket 阈值）；预计耗用预检与"下一 tick 优先"；落选者排在所属模块或同层依赖之前时，依赖先被判定，依赖准入时落选者可以准入（防止永久落选）；依赖空闲不阻挡、落选则阻挡；每个进程每 tick 只判定一次；因预算落选时衰减预计值、因依赖落选时不衰减，预算收缩后自适应长计算能重新准入；预热；紧急刹车只跳过非生存层，被跳过的进程不记样本、按落选计数，层耗用仍计入已运行的部分；维护层准入不逐 tick 计算哈希（以调用次数确认）；计量在钩子之间只读一次 `getUsed()`（以调用次数确认）；`remaining()` 与 `shouldYield()` 按层计算。kernel 的集成测试确认 Memory 维护每 tick 作为收尾任务运行，不受准入影响。
