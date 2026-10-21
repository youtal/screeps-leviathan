# M1 第 4 步工作区第二轮审计（segments、bootPort、intershard）

## 基线与范围

- 日期：2026-10-20。
- 分支：`feat/segments-bootport`；HEAD：`e349fa42de03e970c48b866b5bbf911cabaef2eb`，与 dev 相同，没有任务提交。
- 审计对象：与[第一轮审计](./2026-10-20-segments-bootport-delivery.md)相同的工作区改动，范围是 SB-01–SB-03 整改后的状态。
  - 本轮独立复查全部改动；
  - 重点复核整改代码本身：`src/main.ts` 的失败计数与 `src/kernel/bootPort/index.ts` 的 epoch 取法。
  - 第一轮报告最后一次修改之后，`src/` 与 `test/` 下没有文件再被修改。
- 关键文件 SHA-256 前 12 位：

  | 文件 | 哈希 |
  | --- | --- |
  | `src/main.ts` | `a33bb1c8a835` |
  | `src/kernel/lifecycle/index.ts` | `19123996e448` |
  | `src/kernel/bootPort/index.ts` | `6a369c204b5a` |
  | `src/kernel/bootPort/backup.ts` | `64933d47d813` |
  | `src/kernel/segments/index.ts` | `fbd5478bcd39` |
  | `src/kernel/memory/runtime.ts` | `44ef5fb1ee7f` |
  | `src/kernel/memory/marker.ts` | `94fc8d4aa907` |
  | `src/kernel/memory/commit.ts` | `3be4e4a14c14` |
  | `src/contracts/boot.ts` | `249c063a58fe` |
  | `docs/design/kernel/README.md` | `a3530b4a02bf` |
  | `docs/design/kernel/bootPort.md` | `533b1001ee5f` |
  | `docs/design/kernel/segments.md` | `bd90afff1078` |

  下文行号对应这份快照。
- 依据：架构设计 5.5、5.6、6.7、6.8、11.3、11.4、11.7、11.8；[contracts](../design/contracts/README.md) 第 6.3 节；[kernel](../design/kernel/README.md)、[memory](../design/kernel/memory.md)、[segments](../design/kernel/segments.md)、[bootPort](../design/kernel/bootPort.md)、[intershard](../design/kernel/intershard.md) 模块设计；driver 公开源码 [data.js](https://github.com/screeps/driver/blob/master/lib/runtime/data.js)、[runtime.js](https://github.com/screeps/driver/blob/master/lib/runtime/runtime.js)。
- 前置检查：
  - [挂起问题列表](./suspended.md)当前为空；
  - [Memory v1 工作区交付审计](./2026-10-19-memory-delivery.md)的 MA-04 已延后，本报告不重复提出。MA-04 指低于当前版本的根 schema 无法加载，此时 `summary().marker` 只保证 `sig` 与 `schema`；SR-02 的成因不同，见该节。
- 本轮约束：只新增本报告并更新索引，不修改实现、测试或三份最高章程，不提交、不合并。

## 结论

**没有阻断合并的问题，但 SB-01 的整改留有一条绕过路径。** 类型检查、25 个测试套件共 327 项测试、构建、`git diff --check` 与 3 个私服场景全部通过（见"验证"）。

确认 2 项 P3、2 项 P4：

- **SR-01（P3）**：boot 在登记软重置的同一 tick 抛错时，tick 计为 degraded 而不是 paused，SB-01 的超限判断不生效，入口每 tick 重新装配并解析 Memory，没有冷却；
- **SR-02（P3）**：命名空间的 `sys` 合法、其余结构损坏时，Memory 加载失败，但 `summary()` 仍给出完整的同 schema 标记，bootPort 设计"加载失败时 `parsed` 为 false 或 `marker` 为 null"的表述不成立；boot 会把无法加载的 Memory 判为 OURS；
- **SR-03（P4）**：`sys` 被隔离期间，segments 写出的页头 epoch 取 heap 中的非法值并按 0 处理，与持久化标记的 epoch 不一致；
- **SR-04（P4）**：`src/main.ts` 的文件摘要与 `KERNEL_CRASH_LIMIT` 的注释仍按"只计抛错"描述，没有随 SB-01 的整改同步。

分级沿用第一轮报告：

- **P3**：可以延后、但应记录处置的潜在问题或运行成本问题；
- **P4**：文档或注释缺口，或只在调用方违反约定时出现的边角问题。

临时 boot 不调用任何特权操作，以上问题目前都没有线上影响；SR-01、SR-02、SR-03 会在第 6 步 app.boot 接入后变为可触发。

## 问题

### SR-01 · P3 · 软重置与 boot 抛错同时发生时绕过冷却

**类别：范围内修正（需取舍）。证据：源码确认、测试复现。**

- **来源**：
  - [bootPort/index.ts](../../src/kernel/bootPort/index.ts#L161) 第 161 行，`softReset()` 置位 `reset`；
  - 第 172–176 行的 `run()` 在钩子抛错时只关闭端口，不撤销本 tick 的登记。
- **传播**：
  - [lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L252) 第 252–254 行，`health()` 让 boot 抛错优先于暂停，这样的 tick 返回 degraded；
  - `tick()` 正常返回（第 284–299 行，boot 的异常在 kernel 内部被捕获），`resetRequested()` 仍为 true（第 305 行）。
  - [main.ts](../../src/main.ts#L100) 第 100–106 行：health 不是 paused，所以 `paused` 清零、`overLimit` 为 false，`crashes` 被清零；
  - 第 107–116 行照常销毁实例，但 `overLimit` 为 false，不调用 `countCrash()`。
- **影响**：
  - 如果 boot 的缺陷使每个新实例都"先登记软重置、再抛错"，入口每 tick 都重新装配，新实例首个 tick 完整解析 Memory 文本，与 SB-01 描述的成本相同；
  - 不进入冷却，持续时间没有上限；
  - 保底循环从第 3 个 tick 起每 tick 运行（degraded 计数照常累加），所以生存能力不受影响，受影响的是 CPU。
  - 触发方式举例：判定逻辑在登记软重置后继续执行，并在 Memory 加载失败时访问 `ctx.sys`（此时抛错，见 SR-02），每个新实例的行为都相同。
  - 内核设计第 6 节"重置循环"一条只覆盖了"连续暂停超过上限"，没有覆盖这条路径（[kernel/README.md](../design/kernel/README.md#6-入口正常循环与保底循环) 第 156–157 行、第 176 行）。
- **复现**：在临时副本中运行。
  - R1，真实 kernel：boot 执行 `ctx.port.softReset()` 后抛错，`tick()` 返回 `degraded`，`resetRequested()` 为 true。
  - R2，入口 `createEntry`：每个新实例的 `tick()` 都返回 `degraded`，且 `resetRequested()` 为 true。运行 300 tick 的结果：
    - 装配 300 次；
    - 没有停用报告；
    - 保底循环运行 298 次。
  - R2 用假 kernel 组合 R1 观察到的返回值，没有让真实 kernel 跑满 300 tick。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | boot 钩子抛错时，本 tick 的软重置登记作废：`run()` 在异常路径恢复登记前的值。boot 失败的 tick 本来就不采信判定结果（内核设计第 2 节"boot 失败"），下一 tick boot 在同一实例中重新判定，需要时再次登记 | bootPort 增加数行；同步 bootPort 设计第 3 节 `softReset()` 一行、内核设计第 2 节"boot 失败"，以及 contracts 中 `softReset` 的说明；循环中不再重建实例，运行成本降为一次失败的 boot 调用 |
| B | 入口把"health 不是 paused 时登记的软重置"按一次失败计数，这样的 tick 也不清零失败计数，复用 `KERNEL_CRASH_LIMIT` 与冷却 | `main.ts` 增加数行；保留重建，但每 100 tick 最多 3 次；软重置的契约不变 |
| C | 不改 kernel，在第 6 步 app.boot 的测试中覆盖"登记软重置后不再抛错" | 没有实现成本；kernel 对这类 boot 缺陷没有防线 |

### SR-02 · P3 · 无法加载的命名空间仍给出合法标记

**类别：范围内修正（文档），另有一个新增 API 选项。证据：源码确认、测试复现。**

- **来源**：
  - [runtime.ts](../../src/kernel/memory/runtime.ts#L305) 第 305–311 行：概要在结构校验之前计算。
  - [marker.ts](../../src/kernel/memory/marker.ts#L85) 第 85–93 行：`readMarker` 只校验命名空间中的 `sys`。
  - [runtime.ts](../../src/kernel/memory/runtime.ts#L172) 第 172–199 行：`load` 还会拒绝两类结构，并锁存加载失败：
    - 命名空间字段集合不是 `creeps,flags,part,rooms,sys`（第 178–179 行）；
    - 单元记录非法（第 190–191 行）。
- **传播**：
  - 上述情形下，`summary()` 返回 `parsed: true`，`marker` 是完整的同 schema 标记；
  - 与此同时 `memory.failed()` 为 true，`ctx.sys`、`ctx.memory` 等访问抛错。
  - [bootPort.md](../design/kernel/bootPort.md#3-操作) 第 34 行写明，`summary()` 在"加载失败时 `parsed` 为 false 或 `marker` 为 null"。这句话只对平台读取失败和 JSON 解析失败成立。
  - [内核设计](../design/kernel/README.md#4-上下文)第 131 行只写了 Memory 为 empty 时访问 `sys` 抛错，没有写加载失败的情形。
  - 架构 11.3 的 memState 按概要判断，这种文本满足 OURS 的条件（存在标记、`sig` 匹配、`schema` 不高于当前版本）。
- **影响**：
  - 第 6 步的 app.boot 会把无法加载的 Memory 判为 OURS，进入 11.4 的 c/d 或 11.7 的 NORMAL/RECOVERY 分支。
  - boot 随后读写 `sys` 时抛错：
    - 每个 tick boot 都失败，计为 degraded，由保底循环运行；
    - 没有自动恢复路径，因为清空的闸门由 boot 决定，而 boot 判定的前提已经错了。
  - 结合 SR-01，如果 boot 在登记软重置后才访问 `sys`，还会触发每 tick 的重建。
  - 触发条件：命名空间内出现多余字段或非法单元记录，而 `sys` 保持合法。来源可能是游戏界面的 Memory 编辑、外部工具，或某个版本的写入缺陷。
  - 与 MA-04 的区别：MA-04 是 schema 低于当前版本；本项是同一 schema 下的结构损坏，概要给出的是完整校验过的标记。
- **复现**：在临时副本中以真实 kernel 运行。
  - R3：命名空间多一个字段 `extra`，概要 `parsed` 为 true、`marker` 等于原标记，访问 `ctx.sys` 抛出"Memory 身份或 schema 不匹配"，tick 为 degraded。
  - R3′：一个分区单元缺少 `version`，结果相同。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 只改文档：修正 bootPort 设计第 3 节的表述；在 bootPort 设计第 3 节与内核设计第 4 节写明 Memory 加载失败时访问 `sys` 抛错，boot 以此识别"标记合法但 Memory 无法加载"；把这种情形的判定与处置列为第 6 步 app.boot 设计必须回答的问题 | 不改实现与 contracts；boot 依赖异常识别状态。若要把这种情形归入 11.3 的 CORRUPT，须另行修订架构设计 |
| B（新增 API） | `RawMemorySummary` 增加一个字段（例如 `loaded: boolean`），表示本实例加载是否成功；boot 无需依赖异常 | contracts 变更，须经用户同意；同步 contracts、bootPort 设计与测试 |
| C | Memory 加载失败时让概要的 `marker` 为 null | 改变判定输入：这类文本会落入 FOREIGN，在非开局世界中可能走 11.6 的接手分支，需要重新论证，不建议 |

### SR-03 · P4 · sys 被隔离期间页头 epoch 与持久化标记不一致

**类别：范围内修正。证据：源码确认、测试复现。**

- **来源**：[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L110) 第 110–113 行。
  - 交给 segments 的 `epoch()` 读取 heap 中的 `sys.epoch`，不合法时按 0 处理。
  - 第一轮 SB-03 的"传播"已经列出这条路径，但整改只修改了 `clearMemory()` 的 `previousEpoch()`（[bootPort/index.ts](../../src/kernel/bootPort/index.ts#L110) 第 110–111 行）。
- **传播**：
  - boot 向 `sys.epoch` 写入非法值后，提交时按单元级隔离沿用 `sysText` 写出（[commit.ts](../../src/kernel/memory/commit.ts#L217) 第 217–223 行、第 245 行），持久化的 epoch 不变；
  - heap 中的非法值保持到被修正，期间 segments 写出的页头 `e` 为 0（[segments/index.ts](../../src/kernel/segments/index.ts#L320) 第 320–324 行），回读校验也与 0 比较（第 291 行）。
  - 同理，Memory 提交失败（例如超过 2 Mi 字符）时，页头会带上尚未持久化的 epoch。
- **影响**：
  - 同一实例内，备份回读与 0 比较，结果为 `done`，备份流程本身不受影响；
  - 软重置或 global reset 之后，这些页因 epoch 不符被视为空页。这是安全方向的失效，旧页不会被当作当前页，但页内容丢失。
  - M1 没有跨实例读取 segment 的使用方；风险落在 M5 的读调度上。
  - 触发前提是 boot 写入了非法 epoch，提交时会告警。
- **复现**：在临时副本中运行 R4。
  - 初始条件：epoch 为 6 的已就绪 Memory；boot 每 tick 写入 `epoch = -1` 并推进备份。
  - 结果：备份在第 3 个 tick 为 `done`，备份页头 `e` 为 0，持久化标记的 `epoch` 仍为 6。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | kernel.memory 在建立或更新 `sysText` 的位置（加载、初始化、清空、提交成功）同时缓存其 epoch，并提供内部读取函数；lifecycle 的 `epoch()` 改用它 | kernel 内部增加一个宿主方法，不进入 contracts；每次调用为 O(1)，不解析文本；同步 segments 设计第 4 节"epoch 读取函数取自项目标记"的表述 |
| B | 不改实现，在 segments 设计第 4 节记录：sys 被隔离或提交失败期间写出的页，在之后的实例中视为空页；由 M5 的读调度设计处理 | 没有实现成本；M5 的使用方需要知道这一限制 |

### SR-04 · P4 · 入口注释未随 SB-01 整改同步

**类别：范围内修正（注释）。证据：源码确认。**

- **位置**：[main.ts](../../src/main.ts#L8) 的文件摘要与常量注释。
  - 第 8 行写"连续 KERNEL_CRASH_LIMIT 次抛错后停用正常循环"；
  - 第 10 行写软重置"不计入抛错"；
  - 第 14 行把状态写作"连续抛错"计数；
  - 第 25 行 `KERNEL_CRASH_LIMIT` 的 JSDoc 为"kernel 连续抛出可捕获异常的次数上限"。
- **实际行为**：SB-01 整改后，连续暂停超过 `PAUSE_LIMIT` 后再登记的软重置也计入同一计数（第 76–88 行、第 111–115 行）。内核设计第 6 节已改为"连续失败"（[kernel/README.md](../design/kernel/README.md#6-入口正常循环与保底循环) 第 169 行）。第 12–13 行虽然补了说明，但与第 8、10 行相互矛盾。
- **影响**：README 的源码注释规则要求注释与实现同步。维护者按常量注释理解计数时，会遗漏重置循环这条路径。
- **建议**：把上述四处改为"连续失败（抛错，或超限后的软重置）"的表述。纯注释修改，没有回归测试。

## 已核对事项

以下各项已逐一核实，没有发现问题：

- **SB-01 整改**：
  - `countCrash()` 为抛错与超限软重置共用；
  - 超限的暂停 tick 不清零失败计数；
  - 两项回归测试的期望值（300 tick 装配 19 次、交替时 40 tick 装配 8 次）与"前 10 tick 各 1 次，之后每轮 3 次重建触发一次 100 tick 冷却"一致。
  - 暂停计数在抛错与冷却期间不清零。冷却结束后，若 boot 仍处在重置循环，3 次重建后即再次冷却，这是该测试依赖的行为。代价是冷却后的正常备份暂停会立即按 degraded 计数；只有冷却前已经超限时才会出现。
- **SB-03 整改**：
  - `previousEpoch()` 取"加载时、已签发、当前合法"三者的最大值；
  - `initialize()` 记录已签发的 1；
  - 同一实例两次清空得到递增的 epoch。
- **暂停上限**：重新推导"软重置 + 一次整批重写"的最坏路径，共 7 个暂停 tick：
  - 软重置 1 个；
  - 两轮"写 5 页、写 5 页、请求回读"共 6 个；
  - 完成的那个 tick 不暂停。
  - 7 小于 `PAUSE_LIMIT` 10。
- **driver 语义**（公开源码核实）：
  - 激活但从未写过的页载入为 `""`（data.js：`result[4][i] || ""`），回读得到 `empty` 并进入重写，不会停在 `pending`；
  - 收尾保存时检查键数不超过 10、`parseInt` 页号在 0–99、值为字符串、长度不超过 100×1024，违反即抛错。
  - segments 的 `pageId` 比 `parseInt` 更严格：`"05"` 这类键会被删除，不会被保存，偏向安全。
  - 严格平台模拟与这些语义一致；真实引擎的端到端验证仍按设计在第 6 步进行。
- **segments**：
  - 读后删除与残留键名额；
  - 写出时按当时的 epoch 复核长度；
  - 激活请求以实际载入为准；
  - `setActive` 抛错时已写出的页保留，lifecycle 记录错误。
- **Memory**：
  - `sys` 单元的 `record.data` 是转发到 `state.data.sys` 的访问器属性，清空后指向新标记；
  - `clear()` 清空脏集合时一并移除 `sys` 单元并解除隔离；
  - 分区工厂每次按单元索引查找，清空后同一工厂可以重新申请分区；
  - 提交按当前根键遍历，`peers` 缓存不会写回已清空的外来键。
- **加载失败的其他路径**：
  - 平台读取失败或 JSON 解析失败时，概要为 `parsed: false`，备份因没有文本返回 `failed`，闸门不允许清空；
  - 接管过晚时 `beginTick` 在加载前抛错，不锁存失败，下一 tick 重试。
- **构建与边界**：
  - `virtual:release` 只允许 `app/assembly/` 导入；
  - 存储所有者为 memory、segments、intershard；
  - rollup 插件在构建开始时读取 `package.json` 的版本号。
- **文档**：
  - 改动文档、第一轮报告、README 与 AGENTS 中的相对链接与章节锚点全部可解析（脚本核对）；
  - contracts、memory、kernel 与 bootPort 设计的改动与源码一致，SR-02、SR-04 所列位置除外。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check`（类型检查、单元与边界测试、构建） | 通过；25 个测试套件，327 项测试 |
| `git diff --check`（临时索引包含未跟踪文件） | 通过 |
| `npm run test:scenarios` | 3 个场景全部通过：fallback-takeover、kernel-smoke、memory-takeover。场景不调用特权操作，不覆盖 SR-01–SR-03 的路径 |
| 临时副本中的复现测试 | 5 项（R1、R2、R3、R3′、R4），按"当前实际行为"断言通过，复现 SR-01、SR-02、SR-03；副本位于任务临时目录，工作区的源文件与测试未改动 |

复现测试断言的是当前行为，用于证明问题存在，不作为回归测试交付。SR-01 的影响以装配次数计数确认，没有测量 Screeps CPU；R2 以假 kernel 组合 R1 的返回值，不是 300 tick 的真实 kernel 运行。

## 待用户决定

| 编号 | 建议 |
| --- | --- |
| SR-01 | 方案 A：boot 钩子抛错时，本 tick 的软重置登记作废 |
| SR-02 | 方案 A：修正文档，并把"标记合法但 Memory 无法加载"列为第 6 步 app.boot 设计的待答问题；方案 B 属于新增 API，单独决定 |
| SR-03 | 方案 A：segments 的 epoch 取最近一次合法标记的 epoch |
| SR-04 | 按建议修正四处注释 |

## 整改与复核记录（2026-10-20）

用户决定：四项均按建议整改；SR-02 只采用方案 A，不采用新增 API 的方案 B。整改在同一分支的工作区进行，未提交。

### 整改内容

| 编号 | 整改 | 与建议的差异 |
| --- | --- | --- |
| SR-01 | `src/kernel/bootPort/index.ts` 的 `run()` 在钩子抛错时把软重置登记恢复为调用前的值，再原样抛出异常。同步修改：bootPort 设计第 3 节（`softReset()` 一行与新增"软重置与 boot 失败"）、第 7 节；内核设计第 2 节"boot 失败"、第 6 节"重置循环"；`src/contracts/boot.ts` 与 contracts 设计中 `softReset` 的说明 | 无。入口 `main.ts` 的逻辑不变 |
| SR-02 | 修正 bootPort 设计第 3 节 `summary()` 的失败说明，新增"概要与加载"一条：写明 boot 以访问 `sys` 抛错识别"标记合法但 Memory 无法加载"，判定与处置由 app.boot 的设计规定。同步修改：内核设计第 4 节"BootContext"（加载失败时访问抛错）；`src/contracts/boot.ts` 中 `RawMemorySummary` 的说明；bootPort 设计第 7 节 | 增加一项测试，固定文档所述行为，因为 boot 将依赖它；没有修改实现 |
| SR-03 | kernel.memory 新增内部字段 `sysEpoch`，与 `sysText` 在同一处建立和更新（`runtime.ts` 的加载、初始化、清空，`commit.ts` 的写入成功），并提供宿主方法 `epoch()`；lifecycle 交给 segments 的 `epoch()` 改用它。同步修改 memory 设计"v1：维护与宿主接口"一节、segments 设计第 4 节、bootPort 设计第 7 节 | 无。`clearMemory()` 的 `previousEpoch()` 仍按 SB-03 取三者最大值，未改动 |
| SR-04 | `src/main.ts` 的文件摘要（第 8–12 行）、状态说明与 `KERNEL_CRASH_LIMIT` 的 JSDoc 改为"连续失败"的表述，并注明 boot 抛错时的软重置登记已由 kernel 作废 | 无 |

运行成本：SR-01 消除了"登记软重置后抛错"循环中每 tick 的重新装配与 Memory 解析，只剩一次失败的 boot 调用；SR-03 的 `epoch()` 只读取缓存的数值，不再经访问器按路径读取，segments 每次写页、读页时调用它；其余整改不改变运行路径。

### 回归测试与反向验证

| 编号 | 回归测试 | 反向验证 |
| --- | --- | --- |
| SR-01 | `test/kernel/bootPort/bootPort.test.ts` 新增 1 项：boot 每 tick 登记软重置，前两个 tick 随后抛错，`resetRequested()` 为 false、health 为 degraded；第三个 tick 不抛错时为 paused 且登记生效 | 把恢复语句换成空操作后，该项失败（`● SR-01：…`）；恢复后 `src/kernel/bootPort/index.ts` 哈希为 `587d6044202e`，与修复后一致，19 项通过 |
| SR-02 | `test/kernel/bootPort/bootPort.test.ts` 新增 1 项：命名空间多出字段、或单元记录缺少 `version` 时，概要为 `parsed: true` 且 `marker` 为原标记，访问 `sys` 抛错，tick 为 degraded | 不适用：实现未修改，测试固定的是文档所述的现有行为 |
| SR-03 | 新增 2 项。`test/kernel/bootPort/bootPort.test.ts`：epoch 为 6 的 Memory，boot 每 tick 写入 `epoch = -1` 并推进备份，备份完成后页头 `e` 为 6，持久化标记仍为 6。`test/kernel/memory/boot.test.ts`：`epoch()` 在 empty 时为 0，初始化、清空后立即生效，隔离期间不变，合法写入在提交成功后生效，重新加载后保持，销毁后为 0 | 两处分别撤掉修复：lifecycle 恢复读取 heap 中的 `sys.epoch` 时，内核测试失败；去掉 `commit.ts` 中对 `sysEpoch` 的更新时，Memory 测试失败。恢复后 `src/kernel/lifecycle/index.ts` 为 `29044d4db5d0`、`src/kernel/memory/commit.ts` 为 `77886d4cdd8d`，与修复后一致，34 项通过 |
| SR-04 | 纯注释修改，没有回归测试 | 不适用 |

### 复核验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过；25 个测试套件，331 项测试（新增 4 项），构建成功 |
| `git diff --check`（临时索引包含未跟踪文件） | 通过 |
| 改动文档的链接与章节锚点 | 全部可解析（脚本核对 kernel、contracts 设计与审计目录） |
| `npm run test:scenarios` | 3 个场景全部通过；场景不触发软重置、sys 隔离或特权操作，整改路径由单元测试覆盖 |

整改后的文件哈希（前 12 位）：

| 文件 | 哈希 |
| --- | --- |
| `src/main.ts` | `35d4cc3ca3d2` |
| `src/kernel/bootPort/index.ts` | `587d6044202e` |
| `src/kernel/lifecycle/index.ts` | `29044d4db5d0` |
| `src/kernel/memory/runtime.ts` | `84f9dd5d0e94` |
| `src/kernel/memory/commit.ts` | `77886d4cdd8d` |
| `src/kernel/memory/index.ts` | `278b28e41179` |
| `src/contracts/boot.ts` | `2d9d9767305b` |
| `test/kernel/bootPort/bootPort.test.ts` | `55055f7250e0` |
| `test/kernel/memory/boot.test.ts` | `5806903ae44e` |
| `docs/design/kernel/README.md` | `7e8bc0b2ed15` |
| `docs/design/kernel/bootPort.md` | `772b7355f7b9` |
| `docs/design/kernel/segments.md` | `99b9e4c4e9c1` |
| `docs/design/kernel/memory.md` | `205409895656` |
| `docs/design/contracts/README.md` | `8c8be0f25ae3` |

四项均已关闭，没有遗留问题，也没有需要挂起的问题。"标记合法但 Memory 无法加载"的判定与处置，已按 SR-02 方案 A 写入 bootPort 设计，由第 6 步 app.boot 的设计规定。
