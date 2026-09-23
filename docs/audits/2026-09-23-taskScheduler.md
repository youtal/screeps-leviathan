# TaskScheduler 工作区交付物审计（2026-09-23）

- 审计日期：2026-09-23
- 代码基线：`21fb190`（分支 `feat/task-scheduler`）加未提交工作区：19 个已跟踪文件修改（+103/−26），5 个新文件。工作区指纹 `ebcabb13dfaf27b2400275931f7dd8eb4cd28215f5e3e6e601382f8ac7888b41`：`git diff HEAD --binary` 与按路径排序的未跟踪文件内容拼接后的 SHA-256，在写入本报告前计算
- 范围：TaskScheduler 首版交付物，包括 `src/contracts/task.ts`、`src/core/taskScheduler/`、Runtime/Framework/contracts 的接入改动、`test/taskScheduler.test.ts` 与边界测试改动，以及随附的设计、使用说明、导航和变更记录。其他模块只复查与本次改动相接的部分
- 方法：逐文件通读，对照 [TaskScheduler 设计](../design/core/taskScheduler.md)、[提案](../proposals/cross-tick-tasks.md) 与 AGENTS.md；可疑点用临时用例复现（放在会话临时目录，未写入仓库）；文档示例用 tsc 编译检验；性能用 Rollup 打包 `src/core/index.ts` 后在纯 Node 中测量；统计覆盖率；运行完整验证与私服集成测试
- 交付性质：审计阶段只记录问题与建议，未修改代码与既有文档；整改在确认取舍后进行，见 §9。未提交，未上传游戏服务器
- 导航：[审计索引](./README.md) · [TaskScheduler 设计](../design/core/taskScheduler.md) · [使用说明](../usage/core/taskScheduler.md) · 前次审计：[2026-09-22 全项目](./2026-09-22-project.md) · 整改与关闭：[§9](#9-整改与关闭2026-09-23)、[§10](#10-第二轮决策与实现2026-09-23)

## 1. 结论

没有 P1。共 4 项 P2、5 项 P3、6 项 P4（T01–T15）。

正常路径与设计一致，21 项单元测试、类型检查、构建与三个私服场景全部通过。问题集中在三处：

1. **CPU 口径**（T01）：drive 以 `tickLimit` 为上限。只要有积压任务，bucket 就会被压到任务门限 5000 附近；每个这样的 tick 都在距硬上限只剩 `reserveCpu`（5 CPU）时仍会开始新分片。设计中“最坏只是任务进度落后”的判断不成立。
2. **硬终止恢复分支**（T02、T03）：这段代码没有任何测试，其中有两处缺陷。一个任务重建时抛错，所有 owner 的任务都会永久停摆，而且只留下一条日志。每次分片都超限的任务会绕过 deadline，每 tick 重启一次。
3. **终态语义**（T04）：设计推荐“每 tick 无条件 submit”，按这个写法，已完成的任务会被反复重算，失败和过期对调用方不可见，并会无限重跑。

建议合并前修复 T02、T03、T07（都是局部修改），并对 T01、T04 做出决定；文档与测试缺口（T05、T08、T09）随后补齐。

决策讨论中补充 T16（P3）：插件被停用或熔断后，它提交的任务继续运行。整改结果见 §9：T01–T11、T13–T16 关闭，T12 部分关闭（行为写入文档，处置待决定）。§9.3 的两项设计待决（跨 global “毒任务”、bucket 高水位透支）经确认后在 §10 实现；T12 按 §10.1 的建议实现后关闭。

## 2. 验证结果

| 项目 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过（strict） |
| `npm test` | Jest 13 套件 220 项；构建工具 7 项、产物 3 项、隔离边界 3 项，全部通过 |
| `npm run build`（未设 DEST） | 通过；`dist/main.js` 119,229 B，`main.js.map` 394,885 B。在不含 `.secret.json` 的临时副本中同样通过 |
| `npm run test:integration` | global-reset（3 阶段）、memory（5 阶段）、runtime（4 tick）在私服（screeps 4.3）通过。三个场景都没有提交任务，只覆盖空注册表下的 drive 接入 |
| `git diff --check` | 通过；未跟踪的新文件没有行尾空白，均以换行结尾 |
| 覆盖率（行） | `src/core/taskScheduler/` 93.1%，未覆盖 `createTaskScheduler.ts:115`、`:136`、`:299–307`（硬终止重启分支）；`createRuntime.ts` 100%；`createFramework.ts` 93.5% |
| Markdown 相对链接 | 318 条，无断链 |
| 临时复现 | 15 个用例，全部复现；另有文档示例的 tsc 检验与 3 项打包产物核对 |

## 3. 发现

| 编号 | 级别 | 问题 | 证据 |
| --- | --- | --- | --- |
| T01 | P2 | 任务预算以 tickLimit 为界：有积压任务时 bucket 被压到 minBucket 附近，每 tick 在距硬上限 5 CPU 处仍开始新分片 | 已复现 |
| T02 | P2 | 硬终止后重建任务体时没有错误边界：单个任务抛错使全部 owner 的任务永久停摆，只记录一条日志 | 已复现 |
| T03 | P2 | 硬终止重启分支跳过 deadline 且不限次数：每次分片都超限的任务永不过期，每 tick 重新驱动 | 已复现 |
| T04 | P2 | 终态语义与“每 tick 无条件 submit”冲突：done 读取后被反复重算，failed/expired 对调用方不可见并无限重跑 | 已复现 |
| T05 | P3 | 设计与使用说明的主示例把生成器对象传给 submit：编译不通过，运行时抛 TypeError | tsc、已复现 |
| T06 | P3 | 任务失败的日志去重会被同 owner 的成功分片重置，确定性失败每 tick 记一条 error | 已复现 |
| T07 | P3 | drive 期间被取消的就绪任务会被重新驱动，最后以 TypeError 失败 | 已复现 |
| T08 | P3 | Runtime、Framework、contracts 的文档没有同步更新；任务体内的限制也没有写明 | 读文档、已复现 |
| T09 | P3 | 测试缺口：硬终止分支没有测试，Runtime/Framework 接入没有断言，测试文件头的覆盖说明与实际不符 | 覆盖率 |
| T10 | P4 | 句柄是提交或查询那一刻的快照，保存下来的句柄不会更新 | 已复现 |
| T11 | P4 | 未读的终态条目永久驻留；deadlineTicks 与 cancel 都不能释放它们 | 已复现 |
| T12 | P4 | 任务在 drive 中发布事件时，订阅者的失败不计入熔断 | 已复现 |
| T13 | P4 | 设计、契约与注释之间有多处文本不一致 | 读码 |
| T14 | P4 | 变更记录称集成测试“含硬终止恢复场景”，容易被理解为覆盖了任务调度 | 核对场景 |
| T15 | P4 | 工程一致性问题 | 读码、已复现 |
| T16 | P3 | 插件被停用或熔断后，它提交的任务继续运行（决策讨论中补充） | 已复现 |

### T01（P2）：任务预算以 tickLimit 为界

- 位置：`src/core/taskScheduler/createTaskScheduler.ts:340`（`while (!queue.isEmpty && cpu.remaining() > 0)`）；`src/core/framework/cpuGovernor.ts:47–53`（`remaining()` 为 `(tickLimit ?? limit ?? 20) − getUsed() − reserveCpu`）；`src/core/framework/createFramework.ts:585–589`。
- 机制：drive 复用 Framework 的 CpuBudget。`remaining()` 以 `tickLimit` 为上限，而 bucket 充足时 tickLimit 可达单 tick 上限 500，远高于常规额度 `limit`。任务的缺省 minBucket 是 5000，所以只要 bucket 不低于 5000 且有积压任务，drive 就会一直推进到 `getUsed ≈ tickLimit − reserveCpu`。循环只在开始新分片前检查 `remaining() > 0`，因此最后一个分片可能在余量不足 5 CPU 时开始。提案 §4 原有“单个任务每 tick 有片额上限”，设计改为同优先级轮转后，每 tick 的总量也没有上限。
- 复现：
  - 取 limit 20、tickLimit 500、默认 reserveCpu 5。每分片 1 CPU 的任务在一个 tick 内用到 495 CPU。每分片 12 CPU 的任务，最后一片在 492 时开始、504 时结束，越过了 tickLimit；在真实引擎中这就是 CPU 硬终止。
  - 用简化的 bucket 模型模拟（tickLimit = min(500, bucket)，每 tick bucket += limit − used，插件自身每 tick 用 10 CPU）：bucket 从 10000 开始，11 tick 内降到 4775；此后每次回升过 5000 就被任务消耗约 475，长期停留在约 4500–5000 之间。
- 影响：
  - 任务会把 bucket 盈余一直消耗到 minBucket，bucket 长期停在 5000 附近。应对突发负载的余量因此减半；官方服务器生成 pixel 需要满 bucket，也无法生成。
  - 有积压任务的每个 tick 都在距硬上限 5 CPU 处结束，只要某个分片超过当时余量，整个 tick 就会被硬终止。设计 §5.1 称“即使任务的分片粒度估算有偏差，最坏结果也只是任务本身进度落后，不影响其它环节”，这一判断不成立：硬终止结束的是整个 tick 的脚本；按[集成测试说明](../testing/integration.md)，官方服务器可能在硬终止后重建 isolate，相当于一次 global reset。硬终止变得常见后，T02、T03 所在的分支也会成为常规路径。
  - 使用说明没有给出单个分片的安全上限。
- 建议：需要决定任务可用的 CPU 口径。可选方案：
  - A：drive 只使用常规额度 `limit` 的剩余部分，bucket 高水位（例如 ≥ 9000）时才允许透支；
  - B：为任务设置每 tick 的 CPU 总上限，并且只在余量高于分片安全边距时才开始新分片；
  - C：保持现状，在设计中写明“任务会把 bucket 消耗到 minBucket”及硬终止风险，并在使用说明中给出单分片上限。

  无论选哪种方案，都应修正设计 §5.1 中关于最坏情况的描述。

### T02（P2）：硬终止后重建任务体时没有错误边界

- 位置：`createTaskScheduler.ts:298–307`，`sweep` 中的 `entry.generator = entry.body(entry.context)`。
- 机制：`sweep` 发现 `midSlice` 为真时，直接调用 `body` 重建生成器，不经过 ErrorMapper。`TaskBody` 可以是任意返回生成器的函数，例如 `() => plan(Game.rooms[name].controller!.pos)`；房间失去视野后再调用就会抛错。异常逃出 `sweep` 后整个 drive 失败，而 `midSlice` 仍为真，下一 tick 重复同样的过程。
- 复现：让一个任务的首个分片被硬终止（临时用例用一个穿透错误边界的异常模拟：`midSlice` 保持为真，drive 中途退出，调度器看到的状态与真实硬终止相同），并让它在重建时抛出 TypeError。之后 5 个 tick 的 drive 全部抛错，另一个 owner 的就绪任务一直停在 queued。经 Framework 连续运行 8 个 tick，`framework/tasks.drive` 只记录了 2 条 error（模拟的硬终止 1 条、TypeError 1 条，其余都被 ErrorMapper 去重）；safeMode 为假。真实引擎中硬终止那一 tick 不会留下日志，因此只剩一条。
- 影响：单个任务的故障让所有 owner 的任务停摆到 global reset，日志只有一条。这违反了契约 `TaskHost.drive` 的承诺（“单个任务抛出的异常……不会从 drive 抛出”），也违背设计 §1 的失败隔离目标。
- 建议：在错误边界内重建（沿用 `errorMapper.capture`，归属 owner），失败时把该任务标记为 failed；遍历中单个条目出现异常，不应中断整个 `sweep`。补一条回归用例：注入让特定异常穿透的 ErrorMapper 来模拟硬终止。

### T03（P2）：硬终止重启跳过 deadline 且不限次数

- 位置：`createTaskScheduler.ts:298–319`（`if (entry.midSlice) {…} else if (deadline) {…}`）；`:308–309` 的注释。
- 机制：重启分支与过期分支互斥。如果一个任务每次分片都会越过 CPU 上限（例如分片内死循环，或一次过大的 `PathFinder.search`），它在每次 `sweep` 时都处于 `midSlice` 状态，只会进入重启分支，过期检查永远轮不到。重启也没有次数上限。
- 复现：一个 deadlineTicks 为 3 的任务，每个分片都被“硬终止”。10 个 tick 中，drive 被终止 10 次，body 被重建 10 次，状态始终是 running，从未过期。
- 影响：deadline 本来就是为了防止“写错的任务永久占用调度器”，却恰好在最需要它的场景失效。在 bucket 不低于 minBucket 的每个 tick，这个任务都会触发一次硬终止；按 T01 的口径，bucket 每次回升过 5000 就会再触发一次。注释说 firstTick 刻意不重置是为了“避免反复被硬终止的任务借此无限续命”，实际做不到。如果官方服务器在硬终止后重建 isolate，注册表会被清空，`midSlice` 探测完全失效；调用方每 tick 重新提交，同样会反复硬终止。
- 建议：过期检查与重启检查分开进行，先判断是否过期；给重启设上限，超过后把任务标记为 failed，并在 `failure` 中注明是被硬终止中断。另一种做法是按设计 §5.7，在私服实测之前默认不重启、直接失败。跨 global 的“毒任务”防护（例如由提交者在分区中记录）需要单独做设计决定。

### T04（P2）：终态语义与推荐用法冲突

- 位置：`createTaskScheduler.ts:221–242`（`submitFor`）、`:154–168`（`toHandle` 在终态时标记已读）、`:320–321`（回收已读终态）；设计 §4、§5.5、§5.7；使用说明中的“提交任务与轮询结果”和“规则与注意事项”。
- 机制：设计与使用说明推荐每 tick 无条件调用 `submit` 并读取返回的句柄。但在实现中：
  - done 的结果只保护到第一次被读取。`submit` 返回 done 句柄本身就算读取，下一次 drive 会回收该条目，再下一次 `submit` 会从头重新创建任务；
  - failed、expired、cancelled 状态的条目在 `submit` 时直接被新实例替换，所以 `submit` 返回的永远是 queued 句柄。
- 复现：
  - 一个两个分片即可完成的任务，按推荐写法运行 20 个 tick：body 执行了 10 次，结果被“应用”了 10 次，即每 2 tick 重算一次；
  - 一个首个分片就抛错的任务，运行 10 个 tick：`submit` 返回的状态只有 queued，body 执行了 10 次；
  - 一个 deadlineTicks 为 3 的无尽任务，运行 12 个 tick：`submit` 只返回过 queued 和 running，从未返回 expired；过期后会被立即重建。
- 影响：按推荐写法，已完成的计算会被无限重复。确定性失败每 tick 重跑一次（叠加 T06，每 tick 记一条 error），调用方却无法得知任务失败了；使用说明示例中的 `plan.state === 'failed'` 分支永远执行不到；deadline 的止损作用也被抵消。
- 建议：需要决定终态语义。可选方案：
  - A：所有终态都保留到被读取一次。`submit` 遇到未读的终态时返回该终态句柄，读取之后才重建，至少保证 failed 和 expired 能被调用方看到一次；
  - B：`submit` 从不自动重启终态任务，重启需要显式调用（例如 `restart(id)`），或先 `release`。

  两种方案都需要同步修正示例：读取结果后缓存结果并停止提交，或先用 `get` 判断状态。

### T05（P3）：主示例无法编译

- 位置：`docs/usage/core/taskScheduler.md:32–51`；`docs/design/core/taskScheduler.md:92–110`；提案 §3。
- 机制：`submit('layout:W1N1', planLayout('W1N1'), …)` 传入的是生成器对象，而契约要求任务体是 `(context) => Generator` 形式的函数。
- 复现：逐字编译使用说明中的示例，tsc 报 TS2345（`Generator<undefined, number[], unknown>` 不能赋给 `TaskBody<unknown>`），`plan.result` 也随之被推断为 `{}`；以 JavaScript 方式传入时，`submit` 抛出 TypeError（`entry.body is not a function`）。改为 `() => planLayout('W1N1')` 后编译通过。
- 建议：改正设计与使用说明中的两处示例；提案作为历史记录，可以加注说明。还可以在 `test/contracts.types.ts` 中加一条编译期用例，锁定正确的示例写法。

### T06（P3）：任务失败的日志去重失效

- 位置：`createTaskScheduler.ts:268–271`（`capture` 的元数据为 `{ pluginId: owner, phase: 'framework' }`）；`src/core/errorMapper/createErrorMapper.ts:181–182`（任何一次成功都会删除去重记录）。
- 机制：默认报告出口按（插件、阶段）去重，只要有一次成功就重置。任务失败与同一 owner 下所有任务的成功分片共用（owner, framework）这一个键。
- 复现：同一 owner 另有一个长任务时，每 tick 重新提交的确定性失败任务在 5 个 tick 内记录了 5 条 error；没有其他任务时只记录 1 条。
- 影响：这与 G02 修复前的每 tick 刷屏相同；开启邮件时，每 tick 都会调用 `Game.notify`。叠加 T04 的无限重跑后，这就是推荐用法下的默认表现。
- 建议：为任务失败提供按任务身份去重的报告路径。ErrorMapper 契约目前只有按插件与阶段去重的默认出口，这一点需要与 T04 的语义决定一起设计。

### T07（P3）：drive 期间被取消的任务被重新驱动

- 位置：`createTaskScheduler.ts:340–344`（弹出后直接 `driveOnce`，不检查状态）。
- 机制：就绪队列在 drive 开始时建好。在同一轮中，如果某个任务（或 drive 期间触发的事件回调）对另一个就绪任务调用了 `cancel()`，被取消的条目仍留在队列里；弹出后它会被重新置为 running，而此时 `generator` 已被释放，调用 `next()` 抛出 TypeError。
- 复现：让高优先级任务在分片中取消一个低优先级任务。结果低优先级任务的状态为 failed，failure 为 `TypeError: Cannot read properties of undefined (reading 'next')`，并记录了 1 条 error。
- 建议：弹出后先检查 `isActive`，如果任务已不再活跃，直接丢弃。

### T08（P3）：相关模块文档没有同步更新

AGENTS.md §6 要求：修改公共行为、配置或返回契约时，必须同步更新对应的设计文档和使用说明。

- Runtime：`docs/design/core/runtime.md`（依赖图、“CoreRuntime 发布 …”、RuntimeOptions 分组、createContext 的描述）与 `docs/usage/core/runtime.md`（配置表、可替换项、CoreRuntime 字段）都没有加入 `tasks`、`RuntimeOptions.taskScheduler`（含 `defaultMinBucket`）和 `RuntimeOverrides.tasks`。
- Framework：`docs/usage/core/framework.md` 的“上下文”列表中没有 `tasks`；描述 tick 时序时只写到 MemoryHost 的 `end`，没有提到之后的任务驱动。
- contracts：`docs/usage/contracts.md` 写测试替身须提供“getGame、Logger、EventBus、MemoryHost、Profiler、ErrorMapper 与上下文工厂”，但现在还必须提供 TaskHost。已复现：按这份清单拼出的替身交给 Framework 后，Framework 在激活插件时 `runtime.tasks.bind` 抛错，每个 tick 都进入 safeMode，插件一次也没有运行。
- TaskScheduler 使用说明没有写明任务体内的限制：
  - drive 发生在 MemoryHost.end 之后，任务中写入分区会抛出 `MemoryManager: modifications are only allowed between begin and end`，任务因此变为 failed（已复现）；在任务中申请分区同样会被拒绝；
  - 任务中提交意图也会被拒绝，因为 drive 期间 Kernel 的归属是 framework（读码）。

  设计 §7 的检查点方案同样依赖“由提交者在自己的钩子里写入”这一前提。
- 建议：补齐上述文档，并把任务体的限制写入使用说明的“编写任务体”一节。

### T09（P3）：测试缺口

- 硬终止重启分支（`createTaskScheduler.ts:298–307`）没有任何测试，覆盖率报告已确认；T02、T03 都出在这里。可以注入一个让特定异常穿透的 ErrorMapper 来模拟硬终止。
- `test/taskScheduler.test.ts` 的文件头称“Runtime 是否正确装配 tasks、Framework 是否在正确时机调用 drive，由 test/runtime.test.ts、test/framework.test.ts 与 test/coreDependencyBoundary.test.ts 覆盖”。实际上前两个文件本次没有修改，其中也没有任何关于 tasks 的断言；现有 Framework 用例只是在空注册表上顺带执行了 drive。目前缺少以下断言：
  - drive 在 MemoryHost.end 之后执行，safeMode 时跳过；
  - drive 抛错时不置 safeMode，并记录诊断；
  - `PluginContext.tasks` 按插件 id 归属；
  - `createContext` 按模块名绑定；
  - `RuntimeOverrides.tasks` 生效。
- 私服集成场景从未提交过任务。设计已把真实引擎下的硬终止行为列为待验证事项，可以在 `leviathan-memory` 的硬终止阶段增加一个“任务分片死循环”的变体。
- 建议：按上述补齐，并在关闭 T02、T03 时一并做反向检查。

### T10（P4）：句柄是快照

`toHandle` 返回的是提交或查询那一刻的静态对象，保存下来的句柄的 `state` 不会再变化。已复现：任务已经 done，保存的句柄仍显示 queued。契约中 `TaskHandle` 的 `readonly state` 和“按状态轮询”的描述，容易让人以为 `state` 是实时的。

建议在契约与使用说明中写明“每次轮询都要重新调用 `submit` 或 `get`”，或者把 `state`、`result`、`failure` 改为访问器。

### T11（P4）：未读的终态条目不回收

`sweep` 只回收已读的终态条目。未读的 cancelled、expired、failed、done 条目，连同它们的 body 闭包，会一直留在注册表中；已复现：50 个 tick 后仍可取回。deadline 只作用于活跃任务，`cancel()` 对终态任务是空操作，因此使用说明中“不打算再读取的任务应当搭配 deadlineTicks，或者干脆调用 cancel()”的建议并不起作用。由于 id 可以按房间等动态数据生成，注册表会随时间增长。

建议给终态条目设保留期限（例如按 deadlineTicks 或固定的 tick 数回收），进入终态时释放 `body`，并修正使用说明。

### T12（P4）：在 drive 中发布事件

任务可以通过捕获的插件上下文发布事件。订阅者的回调在 `tasks.drive` 阶段执行，这时健康统计已经完成，而失败集合会在下一 tick 开始时清空，所以这些失败不计入连续失败次数。已复现：订阅者每 tick 都失败，8 个 tick 都没有熔断；同样的失败发生在 tickExecute 中时，3 个 tick 后熔断。另据读码，critical 订阅者的失败会在 tick 已经结束后才把 safeMode 置为真。

设计只写了“任务只做计算、不提交意图”，没有规定任务能否发布事件。建议做出决定：drive 期间拒绝发布，或者把这类失败计入下一 tick 的健康统计。

### T13（P4）：文本不一致

| 位置 | 问题 |
| --- | --- |
| 设计 §3.1 `deadlineTicks` | 设计写“从首次运行起”，契约、使用说明与实现都是“从任务创建起”。bucket 长期不足时，两种口径算出的过期时间不同 |
| 设计 §3.2 与 §8 第 5、6 条 | §3.2 仍称 getStatus 的字段“留待实现确定，见 §8”，而 §8 已用删除线加“已实现为…”“已完成…”标注。已决定的事项应写入正文，并从待决列表中移除 |
| 设计 §5.7 | 设计写“驱动前写入带 tick 归属的运行标记”，实现用的是布尔值 `midSlice`。drive 每 tick 至多执行一次，所以两者行为等价，但文本需要对齐 |
| `Phase` 新增 `'tasks.drive'` | 这一公共契约变更没有写入设计。设计 §5.6 与 Framework 设计 §8 称 drive 故障按与 MemoryHost.begin 同等的边界处理，而 MemoryHost.begin 使用的是 `'framework'` |
| `TaskOptions.minBucket`、`TaskSchedulerOptions.defaultMinBucket` 的注释 | “缺省高于框架对普通插件的准入门限”只在 Framework 使用默认 minBucket（1000）时成立；两个值分别配置，没有联动 |
| `TaskScheduler.get` 的注释 | 注释称“已终结且已被读取过时返回 undefined”，实际要等到下一次 drive 清扫之后才返回 undefined |
| `sweep` 的注释 | 注释称三类处理“互斥”，而这正是 T03 的成因 |

### T14（P4）：变更记录中的验证描述

`docs/changelog/2026-09-23.md` 的 TaskScheduler 条目写道：“`npm run test:integration`（真实 Screeps 4.3 引擎，3 个场景含硬终止恢复场景）”。但三个场景都没有提交任务；其中的硬终止阶段（`leviathan-memory` 阶段 4）是插件回调内的死循环，不涉及 TaskScheduler 的硬终止恢复。建议写明：集成测试只覆盖空注册表下的 drive 接入。

### T15（P4）：工程一致性

- `src/core/index.ts`（Core 统一出口）没有导出 `./taskScheduler`，文件摘要中的模块列表也没有更新。
- AGENTS.md §10 列出的组合根可导入工厂只有 Logger、EventBus、MemoryManager、Profiler 与 ErrorMapper，而 `test/coreDependencyBoundary.test.ts` 已加入 taskScheduler，两处不一致。修改 AGENTS.md 需要用户确认。
- 已复现：`runtime.createContext('')` 现在会抛出 `Invalid task owner`，此前可以正常创建上下文。这一行为变化没有记录。
- `test/taskScheduler.test.ts` 中 `countingTask` 的 `trace` 参数没有被使用，注释却称会把快照推入 trace。
- 设计 §8 第 2 条“是否允许嵌套提交子任务”仍待决，实现既没有拒绝，也没有说明其行为：在 drive 中提交的任务要到下一 tick 才开始驱动。
- 可选的性能细节：每个分片采样 3 次 `getUsed`（开启 Profiler 时为 5 次），其中循环判断与分片前的采样可以合并；Profiler 标签每个分片拼接一次，可以在创建条目时预先计算（同 G07 的做法）。实测影响很小，见 §5。

### T16（P3）：插件释放后任务继续运行

- 位置：`src/core/framework/createFramework.ts` 的 `dispose` 只执行插件登记的清理函数并移除服务，不涉及任务；TaskHost 也没有按 owner 释放的入口。
- 复现：插件在 `onTickExecute` 中提交无尽任务。第 3 tick 停用该插件后，其任务在此后每个 tick 仍被驱动 495 片（每片 1 CPU）；插件连续失败被熔断后同样如此，8 个 tick 内从未停止。
- 影响：熔断的本意是让故障插件不再参与后续 tick，但它的任务照样消耗 CPU；结果无人读取，永久占用 heap。插件被替换时，新实例按同一 id 提交会拿到旧实例留下的任务，其中捕获的是旧实例的闭包。
- 建议：TaskHost 增加按 owner 释放的入口，Framework 在释放插件时调用。

## 4. 核查通过的项目

- 正常路径与设计一致：生成器跨 tick 恢复、同 id 幂等提交、owner 命名空间隔离、同优先级轮转（`roundServed` 在每次驱动后更新）、严格优先级、预算耗尽即停、按任务的 minBucket 准入、单任务异常隔离与归属（`pluginId` 为 owner，`phase` 为 framework）、cancel、非硬终止路径下的 deadline 过期、已读条目回收、TaskContext 访问器、非法配置同步拒绝。
- 驱动时机：drive 位于所有插件的 tickEnd、健康统计与 MemoryHost.end 之后，safeMode 时跳过；drive 抛错只经宿主错误边界记录，不置 safeMode（T02 的 Framework 复现中可以看到）。
- 权限：drive 期间 Kernel 的归属是 `framework`，任务无法提交意图、订阅或发布服务（读码）；写分区会被 MemoryManager 拒绝（见 T08）。
- 依赖边界：TaskScheduler 只导入 contracts 与 `utils/priorityQueue`；Runtime 是唯一的装配点，TaskScheduler 装配在 Logger、Profiler、ErrorMapper 之后；边界测试通过。存储边界：TaskScheduler 不访问 Memory 或 RawMemory，memoryBoundary 测试通过。
- 类型：`Omit` 保证 Runtime 注入的四项依赖不能被配置覆盖；`PluginContext.tasks` 为必选字段；生成器函数可以直接作为 `TaskBody`，按契约的写法编译通过。
- 文档：导航、设计与使用索引、提案状态均已同步；新增源文件都有文件摘要。

## 5. 性能（Node v24.20.0，Rollup 打包后测量）

| 场景 | 每分片耗时 |
| --- | --- |
| 直接调用生成器 `next()`（基线） | 0.019 µs |
| `drive`，1 个任务，关闭 Profiler，计数型预算 | 0.21 µs |
| `drive`，50 个任务 | 0.29 µs |
| `drive`，1 个任务，开启 Profiler | 0.36 µs |
| 分片内工作约 0.16 ms：基线 / 经 drive | 161.8 / 162.1 µs（+0.2%） |

经完整的 Framework loop 测量（使用真实的 CpuGovernor，`getUsed` 按真实耗时计）：每分片采样 3 次 `getUsed`（开启 Profiler 时为 5 次）；空分片约 0.28 µs，开启 Profiler 时约 0.43 µs。按提案建议的分片粒度，调度自身的开销可以忽略。设计 §5.2 要求的真机 Profiler 实测仍未进行；`getUsed` 在官方运行时中的单次成本未知。

## 6. 建议处理顺序

1. T02、T03、T07：调度器内部的局部修复，每项配回归用例并做反向检查；T09 中的硬终止测试随之补齐。
2. T04、T01：需要做出决定——前者是终态语义，后者是任务可用的 CPU 口径与分片安全边距。T06 依赖 T04 的决定。
3. T05、T08、T13、T14：文档修正，可以一次完成。
4. T09 的其余部分：补 Runtime/Framework 接入的断言，以及集成场景变体。
5. T10–T12、T15：P4 收尾。其中 AGENTS.md §10 的清单更新需要用户确认。

## 7. 范围外观察（未修改）

- `src/core/framework/cpuGovernor.ts:42–43` 的注释称“bucket 为空时引擎允许透支到更高额度，此时它高于 limit”，方向写反了：bucket 有余量时，tickLimit 才会高于 limit。这一点与 T01 的判断直接相关；按规范只记录，未修改。

## 8. 限制

- 硬终止是用“穿透错误边界的异常”模拟的。调度器看到的状态与真实硬终止相同（`midSlice` 保持为真、drive 中途退出），但真实引擎中生成器被中断后的状态、官方服务器是否会重建 isolate，都没有验证。
- bucket 轨迹使用的是简化模型（tickLimit = min(500, bucket)），只用于说明趋势。
- 性能数据来自本机 Node，只用于量级比较。
- 所有结论都在私服与本机 Node 上得出，官方服务器未验证。

## 9. 整改与关闭（2026-09-23）

- 分支：`feat/task-scheduler`，在本报告基线的工作区上直接整改（交付物尚未提交）
- 原则：需要取舍的 T01、T04 与 AGENTS.md 修改先经确认；其余按报告建议关闭；T12 与新出现的设计问题保持待决
- 方法：每项修复配回归用例，并做反向检查（撤销修复后确认对应用例失败，恢复后通过、文件指纹一致）；私服新增场景 `leviathan-tasks` 验证真实引擎中的硬终止行为

### 9.1 决策

| 事项 | 决定 |
| --- | --- |
| T01 CPU 口径 | `drive` 每开始一片前调用 `cpu.admit()`（普通插件准入口径），任务只用本 tick 常规额度中插件没用完的部分，不透支 bucket；另设单任务每 tick 软上限 `maxCpuPerTick`，调度器缺省值 `defaultMaxCpuPerTick` 为不限 |
| T04 终态语义 | 方案 B：`submit` 只保证实例存在（任何状态都返回已有实例）；新增 `release(id)`；`get`/`submit` 不再有“读取即消费”的副作用；实例连续 `retainTicks`（缺省 1000）tick 未被触碰即回收；Framework 释放插件时回收其任务（T16） |
| AGENTS.md §10 | 组合根可导入的具体工厂清单加入 TaskScheduler |

### 9.2 关闭状态

| 编号 | 处置 | 回归证据 |
| --- | --- | --- |
| T01 | 已修复。循环条件改为 `cpu.admit()`；分片耗时改用 `Game.cpu.getUsed` 差值（不再因 `remaining()` 截断而少算最后一片）；新增 `maxCpuPerTick` 与 `defaultMaxCpuPerTick`。设计 §5.2–§5.4 按新口径重写，删去“最坏只是进度落后”的判断 | Framework 用例 `drives tasks only within the regular limit minus reserveCpu, not up to tickLimit`（limit 20、tickLimit 100 的桩上驱动 15 片）；单元用例 `每开始一片前调用 admit()…`、`maxCpuPerTick 是软上限…`、`达到上限的任务让出的 CPU…`、`defaultMaxCpuPerTick…`。模拟（limit 20，插件每 tick 10 CPU，60 tick）：0.5 CPU 分片每 tick 用 15 CPU，bucket 保持 10000；12 CPU 分片最高 22 CPU，远离 tickLimit |
| T02 | 已修复。硬终止后在 `errorMapper.capture` 内重建任务体，失败只让该任务 failed；清扫中所有可能执行任务代码的步骤都在错误边界内 | `硬终止后重建任务体时 body 抛错…`：drive 不抛出，其他 owner 的任务完成 |
| T03 | 已修复。deadline 先于硬终止恢复判断；同一实例最多重启 1 次，第 2 次被中断以 failed 结束，`failure.message` 注明中断次数 | `硬终止后按 body 重启一次…`、`deadline 先于硬终止恢复判断…`；私服场景阶段 2（§9.4） |
| T04 | 已修复（决策 B） | `done 的结果保持可见，不会被重新计算`（20 tick 内 body 只执行 1 次）、`确定性失败只执行一次，failed 对调用方可见`、`过期保持可见，不会被立即重建`、`release 释放实例…`、`done 的实例 release 后重新提交才会重算`；私服场景阶段 1（完成后每 tick 提交不再重算） |
| T05 | 已修复。设计与使用说明的示例改为 `() => planLayout('W1N1')`，并按新语义重写结果处理；提案保留原文并加注 | `test/contracts.types.ts` 的 `verifyTaskContract`：`@ts-expect-error` 锁定“生成器对象被拒绝”；两处新示例在临时副本中逐字编译通过 |
| T06 | 随 T04 关闭：失败实例保留，不再自动重跑，同一次失败只报告一次 | `确定性失败在同 owner 另有成功分片时也只记录一条 error`（5 tick 1 条） |
| T07 | 已修复。弹出后先检查状态；分片中被取消或释放的任务保留取消结果，不被随后的完成或失败覆盖 | `同一轮 drive 中被取消的就绪任务保持 cancelled…`（无 TypeError 日志） |
| T08 | 已关闭。Runtime 设计与使用说明、Framework 设计与使用说明、contracts 设计与使用说明补入任务调度（`CoreRuntime.tasks`、`RuntimeOptions.taskScheduler`、`RuntimeOverrides.tasks`、上下文绑定、TaskHost 替身须提供的方法、tick 时序与准入口径）；TaskScheduler 使用说明写明任务体不能写 Memory、不能提交意图 | 文档；链接检查 |
| T09 | 已关闭。TaskScheduler 单元测试 21 → 32 项（含硬终止分支）；Framework 任务驱动接入 8 项；Runtime 装配 2 项；编译期回归 1 项；私服场景 `leviathan-tasks`；测试文件头的覆盖说明改正 | `createTaskScheduler.ts` 行覆盖 93.1% → 98.8%（未覆盖的是 Profiler 包装失败的降级与一条 info 日志的惰性内容） |
| T10 | 已修复。句柄在创建实例时生成一次，`state`/`result`/`failure` 为访问器；同一实例的 `submit`/`get` 返回同一对象，轮询不再分配 | `句柄是实例的实时视图…` |
| T11 | 已修复（决策 B）。闲置回收（活跃实例先取消）；进入终态即释放任务体；使用说明改写 | `闲置回收：连续 retainTicks 个 tick 未被 submit/get 触碰的实例被释放` |
| T12 | **部分关闭**。行为写入 Framework 设计 §5.2、TaskScheduler 设计 §8 第 4 条与使用说明（任务不应发布事件；此时订阅者失败只进入诊断、不计入熔断）；如何处置待决定，见 §9.3 | 文档 |
| T13 | 已关闭。deadline 起算点统一为“实例创建起”；§3.2 与 §8 的已决事项并入正文；运行标记按布尔值描述并说明理由；`tasks.drive` 写入 TaskScheduler 与 Framework 设计；`minBucket` 注释写明与 Framework 分别配置；`get` 与 `sweep` 的注释按新实现重写 | 读码 |
| T14 | 已关闭。更正变更记录中首版条目的集成测试描述 | 文档 |
| T15 | 已关闭。`src/core/index.ts` 导出 TaskScheduler；AGENTS.md §10 更新（决策）；`createContext('')` 抛错写入契约注释与 Runtime 文档；在 drive 中提交任务的行为写入设计 §8 第 2 条与使用说明；测试辅助函数的无用参数移除；Profiler 标签在创建实例时拼好，比较器移到模块级，空闲 tick 不分配队列。“合并循环判断与分片前采样”未采纳：改用 `admit()` 后两者含义不同，实测开销见 §9.5 | `binds context tasks to the module name…`（空名抛错）、`在 drive 中提交的任务从下一 tick 开始驱动` |
| T16 | 已修复（决策 B）。TaskHost 新增 `releaseOwner`，Framework 在执行完插件的清理函数后调用；该调用经宿主错误边界执行 | Framework 用例 `releases the tasks of a disabled plugin`、`…circuit-broken plugin`、`…replaced or its setup fails` |

反向检查共 16 项：admit 口径（单元、Framework 各 1）、单任务上限、T02、T03（重启上限、deadline 优先）、T04（done、failed、release）、T06、T07、T10、T11、T16（停用、熔断、替换与 setup 失败）。每项撤销后对应用例失败，恢复后通过，文件指纹与修改前一致。

### 9.3 保持开放

| 事项 | 原因 |
| --- | --- |
| T12 处置 | 需要决定：`drive` 期间拒绝发布事件，或把订阅者失败计入下一 tick 的健康统计（TaskScheduler 设计 §8 第 4 条） |
| 跨 global 的“毒任务” | 官方服务器若在硬终止后重建 isolate，重启计数随注册表丢失，调用方每 tick 重新提交会再次触发硬终止；是否由提交者在分区中记录中断次数，需要设计决定（设计 §8 第 5 条） |
| bucket 高水位透支 | 是否允许任务在 bucket 很高时使用更多 CPU 以加快规划类任务（设计 §8 第 6 条） |
| 真机开销 | `getUsed` 在官方运行时中的单次成本需要在真机上用 Profiler 确认（设计 §5.3） |

### 9.4 私服实测（`leviathan-tasks`）

screeps 4.3 私服，CPU limit 100、tickLimit 500、bucket 10000：

- 阶段 1：计数任务按 2→3→5→7→9→10 片跨 tick 推进后完成；此后每 tick 的 `submit` 返回同一实例，不再重算。
- 阶段 2：分片内死循环被引擎终止 2 次；第一次后 heap 保留（globals 1→1），任务按 body 重启一次；第二次后以 failed 结束，message 为 `interrupted by the hard CPU limit 2 times`；Framework 未进入 safeMode，插件继续运行。
- 阶段 3：硬终止发生在 `MemoryHost.end` 之后，该 tick 已写入的分区标记已经落盘，heap 与存储一致。设计 §5.8 “drive 排在 Memory 提交之后”的前提在私服上成立。

### 9.5 验证

| 项目 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过（strict），含新增的 `@ts-expect-error` 负例 |
| `npm test` | Jest 13 套件 241 项；构建工具 7 项、产物 3 项、隔离边界 3 项，全部通过 |
| `npm run build` | 通过；在不含 `.secret.json` 的临时副本中同样通过 |
| `npm run test:integration` | global-reset、memory、runtime、tasks 四个场景在私服（screeps 4.3）通过 |
| `git diff --check` | 通过；未跟踪的新文件无行尾空白 |
| Markdown 相对链接 | 无断链 |
| 覆盖率（行） | `createTaskScheduler.ts` 98.8%、`createRuntime.ts` 100%、`createFramework.ts` 94.2% |
| 反向检查 | 16 项，见 §9.2 |
| 单分片开销（Node 24，打包产物） | 直接调用 `next()` 0.020 µs；`drive` 每片 0.14 µs（1 个任务）、0.21 µs（50 个任务）、0.27 µs（开启 Profiler）；0.15 ms 的分片约 +0.1%。经完整 Framework loop 每片采样 `getUsed` 4 次（开启 Profiler 6 次） |

### 9.6 范围外观察（未修改）

- §7 已记录的 `cpuGovernor.ts` 注释方向问题仍在。
- `docs/usage/contracts.md` 开头称“Memory 长期访问器、深路径与同步装载错误契约……尚未交付”，与同文后文及契约设计的“已交付”矛盾。本次只修改了该文件中与任务调度相关的段落。

## 10. 第二轮决策与实现（2026-09-23）

§9.3 的开放项按以下决定处理，分支与验证方式同 §9。

### 10.1 决策

| 事项 | 决定 |
| --- | --- |
| 跨 global 的“毒任务” | 计入 Memory：调度器在存储分区中记录每个存续实例经历的 global reset 次数，连续第 3 次 reset 后重新提交的实例直接以 failed 结束 |
| bucket 高水位透支 | 允许：bucket 达到水位（缺省 9500）时，任务可以使用高于水位的盈余 |
| T12 处置 | 按审计方的建议实现（见下），已确认 |

**T12 的建议**：`drive` 期间不让事件进入插件。

- 插件上下文的 `publish` 在 `tasks.drive` 阶段直接抛错，发布事件的任务因此失败，`failure` 写明原因。
- 绕过插件上下文、经 `runtime.bus` 在 `drive` 期间发布的事件，不投递给插件订阅者，并告警一次。

理由如下：

- 与 Framework 按阶段判定权限的做法一致：意图只在 tickExecute 提交，订阅只在 setup 进行，任务只做计算。
- 订阅者在 `drive` 中运行时 Memory 已经提交，它们的分区写入同样会被拒绝，失败也绕过了熔断统计。禁止发布能消除这一整类问题，而不必补统计。
- 违规在源头失败，容易定位。改动集中在 Framework 的插件事件代理，约十行加两条用例。

另一方案“把 drive 中的失败计入下一 tick 健康统计”需要跨 tick 携带失败集合，并处理 critical 订阅者的 safeMode 时机，而且订阅者仍然会在 Memory 提交之后运行，因此不采用。

### 10.2 实现与回归证据

| 项目 | 实现 | 回归证据 |
| --- | --- | --- |
| 跨 global 重启记录 | TaskHost 新增 `persist(tick)`，Framework 在健康统计之后、`MemoryHost.end` 之前调用。Runtime 把 MemoryHost 注入调度器，调度器在内核保留 owner `framework` 下申请分区 `tasks`（owner → 任务 id → reset 次数）。实例创建后第一次 `persist` 时登记：分区中已有同键记录则次数加一，否则为 0；次数超过 2 的实例直接以 failed 结束，message 为 `Task <id> restarted by N global resets without completing`，同时删除记录。实例结束、被释放、被回收或随插件释放后，下一次 `persist` 删除记录。上一 global 留下、`retainTicks` 内无人认领的记录会被清理。只用路径写入，非法 owner/id 只让该条记录失败，不阻断整串写盘；存储不可用时跳过并告警一次 | 单元用例 6 项（真实 MemoryManager，以“同一存储文本新建调度器”模拟 global reset）：第 3 次 reset 后 failed 且记录删除；结束与 release 删除记录；无人认领的记录按期清理；登记前取消的实例不写记录；`__proto__` 作为 id 时只该记录失败；存储不可用时告警一次。Runtime 用例 `gives the task scheduler the shared MemoryHost…`；Framework 用例 `persists task records before MemoryHost.end…`；私服场景阶段 4 |
| bucket 盈余额度 | 新增 `burstBucket`（缺省 9500，`Infinity` 关闭）。`admit()` 拒绝后，若 bucket 不低于水位，已用 CPU 可以到 `limit + min(bucket − burstBucket, limit)`，且 `cpu.remaining()` 须大于 100 | 单元用例 5 项（真实 CpuGovernor 口径）：水位以下 15、盈余 10 时 30、满 bucket 时 40、limit 300 时被 tickLimit 距离限制在 395、关闭时 15；非法配置拒绝 |
| T12 | 已修复。插件上下文的 `publish` 在 `tasks.drive` 阶段抛出 `Events cannot be published while tasks are driven`；插件订阅者的回调包装在该阶段不投递事件，每种事件经 `Framework` 日志作用域告警一次。TaskScheduler 与 Framework 的设计和使用说明写明规则，设计 §8 移除该待决项 | Framework 用例 `rejects publishing through plugin contexts while tasks are driven`（任务 failed、订阅者未被调用）、`does not deliver raw-bus events to plugins while tasks are driven and warns once`（钩子中的发布照常投递，drive 中的发布不投递，告警 1 次） |

反向检查新增 11 项：盈余条件、tickLimit 距离、跨 global 上限、计数继承、结束时删除记录、无人认领记录的清理、登记前已取消、Framework 的 `persist` 调用、Runtime 注入 MemoryHost，以及 T12 的发布拒绝与投递拦截。每项撤销后对应用例失败，恢复后通过，累计 27 项。

### 10.3 私服实测

`leviathan-tasks` 增加阶段 4：沿用“快照 → 新世界”的方式模拟一次 global reset。插件每 tick 提交一个不会结束的任务；新世界中该实例在调度器分区里的记录由 0 变为 1，任务照常运行。阶段 1–3 的结论不变（计数任务每 tick 约推进 2 片后完成；死循环分片被终止 2 次后以 failed 结束；终止所在 tick 的 Memory 已落盘）。

### 10.4 保持开放

| 事项 | 原因 |
| --- | --- |
| 真机开销 | `getUsed` 在官方运行时中的单次成本需要在真机上用 Profiler 确认 |

### 10.5 验证

| 项目 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过（strict） |
| `npm test` | Jest 13 套件 255 项；构建工具 7 项、产物 3 项、隔离边界 3 项，全部通过 |
| `npm run build` | 通过；在不含 `.secret.json` 的临时副本中同样通过 |
| `npm run test:integration` | global-reset、memory、runtime、tasks（4 阶段）四个场景在私服（screeps 4.3）通过 |
| `git diff --check` | 通过；未跟踪的新文件无行尾空白 |
| Markdown 相对链接 | 无断链 |
| 覆盖率（行） | `createTaskScheduler.ts` 99.2%、`createRuntime.ts` 100%、`createFramework.ts` 94.5% |
| 单分片开销（Node 24，打包产物） | `drive` 每片 0.16 µs（1 个任务）、0.22 µs（50 个任务）、0.27 µs（开启 Profiler）；0.15 ms 的分片约 +0.1%；经完整 Framework loop 每片采样 `getUsed` 4 次（开启 Profiler 6 次） |
