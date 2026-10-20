# M1 第 4 步工作区交付审计（segments、bootPort、intershard）

## 基线与范围

- 日期：2026-10-20。
- 分支：`feat/segments-bootport`；HEAD：`e349fa42de03e970c48b866b5bbf911cabaef2eb`，与 dev 相同，没有任务提交。
- 审计对象：工作区中尚未提交的全部改动，包括：
  - 新增模块 `src/kernel/segments/`、`src/kernel/bootPort/`、`src/kernel/intershard/`；
  - kernel.memory 的 `marker.ts`、`sys.ts` 与 `commit.ts`、`index.ts`、`runtime.ts`、`unit.ts` 的改动；
  - `src/kernel/lifecycle/index.ts`、`src/kernel/context/index.ts`、`src/main.ts`、`src/app/assembly/index.ts`、`src/contracts/boot.ts`、`src/env.d.ts`；
  - 构建与测试配置 `rollup.config.mjs`、`jest.config.js`；
  - 新增与修改的测试：`test/kernel/segments/`、`test/kernel/bootPort/`、`test/kernel/intershard/`、`test/kernel/memory/boot.test.ts`、`test/stubs/release.ts`、`test/main.test.ts`、`test/boundary/`、`test/kernel/lifecycle/harness.ts`；
  - 设计文档：`docs/design/kernel/` 下新增的 segments、bootPort、intershard 三份模块设计，kernel、memory、contracts 设计与设计索引的改动，以及经用户同意的架构 14.3 修订。
- 关键文件 SHA-256 前 12 位：

  | 文件 | 哈希 |
  | --- | --- |
  | `src/main.ts` | `9cc5580c85c7` |
  | `src/kernel/lifecycle/index.ts` | `19123996e448` |
  | `src/kernel/bootPort/index.ts` | `61149e3d0559` |
  | `src/kernel/bootPort/backup.ts` | `64933d47d813` |
  | `src/kernel/segments/index.ts` | `fbd5478bcd39` |
  | `src/kernel/memory/runtime.ts` | `44ef5fb1ee7f` |
  | `src/kernel/memory/commit.ts` | `3be4e4a14c14` |
  | `docs/design/kernel/bootPort.md` | `ddcb67f5fae0` |
  | `docs/design/kernel/segments.md` | `bd90afff1078` |
  | `docs/design/kernel/README.md` | `7042c7809444` |

  下文行号对应这份快照。
- 依据：架构设计 4.2、5.5–5.7、6.7–6.9、11.3、11.4、11.8、13.1、14.3 与附录 A；[contracts](../design/contracts/README.md) 第 6.3 节；[kernel](../design/kernel/README.md)、[memory](../design/kernel/memory.md)、[segments](../design/kernel/segments.md)、[bootPort](../design/kernel/bootPort.md)、[intershard](../design/kernel/intershard.md) 模块设计。
- 前置检查：审计前阅读了[挂起问题列表](./suspended.md)，当前为空。[Memory v1 工作区交付审计](./2026-10-19-memory-delivery.md) 的 MA-04（低于当前版本的根 schema 无法加载）已延后到首次提升根 schema 的任务，本报告不重复提出；`summary().marker` 对旧 schema 只保证 `sig` 与 `schema` 属于同一限制。
- 本轮约束：只新增本报告并更新索引，不修改实现、测试或三份最高章程，不提交、不合并。

## 结论

**没有阻断合并的问题。** 类型检查、25 个测试套件共 324 项测试、构建、`git diff --check` 与 3 个私服场景全部通过。

确认 1 项 P3、2 项 P4：

- **SB-01（P3）**：入口对软重置的重建没有频率上限，boot 持续登记软重置时每 tick 都重新装配并解析 Memory，不受抛错冷却约束；
- **SB-02（P4）**：设计把 `sys.release` 的更新交给 boot，但没有规定 boot 如何取得当前版本号，而边界规则只允许 app.assembly 导入它；
- **SB-03（P4）**：`clearMemory()` 的新 epoch 取自 heap 中未经校验的 `sys.epoch`，boot 同 tick 写入非法值后清空会使 epoch 回退为 1。

以下事项已核对，与设计一致：

- 持久化边界：只有 segments、intershard、memory 访问 `RawMemory.segments`、`setActiveSegments` 与 `InterShardMemory`，边界检查已列为存储所有者；
- 依赖与版本注入：没有新增运行时依赖；`virtual:release` 只允许 app.assembly 导入，放行与拒绝都有测试，构建产物含 `release = "0.1.9"`；
- 暂停 tick、软重置、`PAUSE_LIMIT` 与健康判定的优先级，与内核设计第 2、6 节一致；"软重置 + 一次整批重写"的最坏路径为 7 个暂停 tick，小于上限 10；
- 备份状态机、segment 键数不变量与激活集撤销，均与 segments、bootPort 设计一致（详见文末"已核对事项"）。

分级：

- **P3**：可以延后、但应记录处置的潜在问题或运行成本问题；
- **P4**：文档缺口，或只在调用方违反约定时出现的边角问题。

目前临时 boot 不调用任何特权操作，以上问题都没有线上影响；它们会在第 6 步 app.boot 接入后变为可触发。

## 问题

### SB-01 · P3 · 软重置的重建没有频率上限

**类别：范围内修正（需取舍）。证据：源码确认、测试复现。**

- **来源**：[main.ts](../../src/main.ts#L84) 第 84–94 行。
  - 每次 `kernel.tick()` 正常返回后，`crashes` 清零（第 84 行）；
  - 只要 `kernel.resetRequested()` 为真，就销毁实例，下一 tick 由 `deps.assemble()` 重新装配（第 90–94 行）；
  - 冷却期只由抛错计数 `crashes` 触发（第 100–107 行），软重置不参与。
- **传播**：
  - 新实例首个 tick 的 `memory.beginTick` 必然重新读取并解析整份原始文本，同时计算概要（[runtime.ts](../../src/kernel/memory/runtime.ts#L300) 第 300–311 行）。
  - boot 如果在每个新实例中都登记软重置，"重新装配 + 完整解析 Memory"就在每个 tick 发生一次。可能的触发包括：判定逻辑把"本实例首个 tick"误判为"global 已运行过"，或者两次判定结果来回振荡。
  - 连续暂停超过 `PAUSE_LIMIT` 后，暂停 tick 计为 degraded，保底循环从第 `PAUSE_LIMIT + SAFE_MODE_TICKS` 个 tick 起每 tick 运行。但 kernel 仍然每 tick 重建，入口没有其他出口。
- **影响**：
  - 每 tick 的固定开销为 Memory 文本的完整 `JSON.parse` 加装配成本，与 Memory 体积成正比，再加上保底循环本身；
  - 持续时间没有上限，直到代码被修正或重新部署；
  - 内核设计第 6 节为抛错设置冷却期，理由是"持续抛错时每 tick 重新装配会反复解析 Memory"，这条理由同样适用于软重置，但目前没有对应的防线。
- **复现**：在临时副本中以假依赖驱动 `createEntry`，kernel 每 tick 都登记软重置。运行 300 tick 的结果：
  - 装配 300 次；
  - 保底循环从第 13 个 tick（10 + 3）起每 tick 运行；
  - 没有进入冷却。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 连续暂停已超过 `PAUSE_LIMIT` 时，入口把再次登记的软重置按一次抛错计入 `crashes`，复用现有的 `KERNEL_CRASH_LIMIT` 与 `KERNEL_COOLDOWN` | `main.ts` 增加数行，并增加一项入口测试；上限内的正常开局流程（最多约 7 个暂停 tick）不受影响；重建成本被限制在每 100 tick 一次 |
| B | 每个 global 内限制软重置次数，超出后忽略登记并告警 | boot 不知道登记被忽略，会继续停在暂停状态，仍要靠 `PAUSE_LIMIT` 兜底；需要再定义一个上限参数 |
| C | 不改 kernel，在第 6 步 app.boot 的测试中覆盖"新实例不再软重置" | 没有额外实现，但 kernel 对 boot 缺陷没有防线 |

### SB-02 · P4 · boot 取得当前版本号的途径未规定

**类别：范围内修正（文档）。证据：源码与文档核实。**

- **来源**：
  - 架构 6.7 规定 `release` 为"当前运行的版本号"，在"每次 global reset"时更新（[architecture.md](../design/architecture.md#67-项目标记) 第 498 行）。
  - [bootPort.md](../design/kernel/bootPort.md#4-项目标记) 第 67 行把 `lastRun`、`release`、`fp`、`mode` 的更新交给 boot，kernel 不自动维护。
  - 同一文档第 6 节第 82 行只规定 app.assembly 读取版本号后作为 **kernel 选项**传入。
- **传播**：
  - kernel 只在 `initialize()` 与 `clearMemory()` 生成新标记时写入 `release`（[bootPort/index.ts](../../src/kernel/bootPort/index.ts#L88) 第 88–93 行）；
  - `BootContext` 与 contracts 中没有版本号；
  - 边界检查只允许 `app/assembly/` 导入 `virtual:release`（[check.ts](../../test/boundary/check.ts#L36) 第 36 行、第 229 行）。
  - 因此 app.boot 只能读到标记中已有的旧值。
- **影响**：
  - 第 6 步实现 app.boot 时，如果没有补上这条装配，`sys.release` 会停在初始化或上次清空时的版本，不再反映当前运行的版本；
  - 依据项目标记判断线上版本、或核对回滚是否生效时，会得到错误信息。
  - 不影响启动判定本身：判定不读 `release`。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 在 bootPort.md 第 6 节写明：app.assembly 构造 app.boot 时，把同一版本号作为 app 层内部的装配参数一并传入 | 只改文档，不改 contracts，不放宽边界规则 |
| B | 在 `BootContext` 上增加只读的 `release` | contracts 变更，需要用户确认；为 boot 单独开一个字段 |
| C | kernel 在每个实例首次 ready 的 tick 自动写入 `sys.release` | 改变"boot 负责更新时机、kernel 不自动维护"的分工，需要同步修改 bootPort 设计第 4 节 |

### SB-03 · P4 · 清空时的 epoch 取自未经校验的 heap 值

**类别：范围内修正。证据：源码确认、测试复现。**

- **来源**：[bootPort/index.ts](../../src/kernel/bootPort/index.ts#L99) 第 99–102 行。Memory 就绪时，`previousEpoch()` 读取 `memory.sys().get(['epoch'])`，即 heap 中的当前值；值不是非负整数时按 0 处理。第 136 行以它加 1 作为新 epoch。
- **传播**：
  - `sys` 的结构校验发生在提交时（[commit.ts](../../src/kernel/memory/commit.ts#L64) 第 64–71 行）；
  - 校验失败时持久文本沿用上一版合法标记，但 heap 中仍是非法值；
  - boot 在同一 tick 先向 `sys.epoch` 写入非法值、再调用 `clearMemory()`，或者在非法值被隔离的期间清空，新 epoch 都会变成 1，而不是原值加 1。
  - lifecycle 交给 segments 的 `epoch()` 同样读取 heap 值（[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L110) 第 110–113 行），非法时按 0 写出页头。
- **影响**：
  - epoch 回退到 1 后，上一段生涯中 epoch 为 1 的 segment 页会被当作当前页（架构 6.8 安全规则 2）；
  - M1 的 store 不受影响：备份回读比较正文，统计只写不读；
  - 风险落在 M5 第一个读取 segment 的业务 store 上；
  - 触发前提是 boot 写入了非法标记，提交时会告警。
- **复现**：在临时副本中，以 `epoch` 为 6 的已就绪 Memory 启动，boot 在首个 tick 执行 `ctx.sys.set(['epoch'], -1)` 后调用 `clearMemory()`。提交后的项目标记中 `epoch` 为 1。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | `previousEpoch()` 取"加载时标记的 epoch"与"当前合法 epoch"中的较大者 | 只改 bootPort 一处，不新增接口；epoch 在一个实例内只增不减 |
| B | 不改实现，在 bootPort 设计第 3 节"epoch 的起点"中记录这一限制 | 无实现成本；依赖 boot 不写入非法 epoch |

## 已核对事项

以下各项已逐一核实，没有发现问题：

- **segments**：
  - 页格式与解析不抛错；
  - 页号归属、超限都以返回值报告并告警；
  - 键数不变量：读后删除，残留的合法键占用名额，非法键被删除；
  - 每 tick 最多写出 5 页；先按优先级，再按变脏先后；
  - bucket 低时推迟 stats，backup 不受限制；
  - 激活请求以实际载入的页为准：撤销激活的 tick 被丢弃时，下一 tick 再次撤销；
  - 写出页头时取当时的 epoch，同 tick 清空后立即生效。
- **备份状态机**：
  - 全部页写出后才请求回读；
  - 回读比较版本、批次号、序号、页数与正文；
  - 不一致时整批重写一次，再不一致为 `failed`；
  - 读页那个 tick 如果 boot 没有推进状态机，下一次调用会重新请求；
  - 空文本直接 `done`，超过容量为 `failed`；
  - Memory 加载失败时备份仍能写出，有测试覆盖损坏文本"备份 → 清空"。
  - 严格平台模拟把从未写过的页载入为空串，回读得到 `empty` 并进入重写，不会停在 `pending`；真实引擎中的语义按设计在第 6 步的私服场景复核。
- **Memory**：
  - 概要与索引共用一次解析；
  - `clear()` 先完成复制再改状态，同时撤销旧单元并清除失败锁存；
  - 提交按当前根键遍历，`peers` 缓存不会把已清空的外来键写回；
  - `sys` 只在变脏时校验，非法时按单元级隔离沿用 `sysText`；
  - `dispose` 会释放原始文本。
- **lifecycle 与入口**：
  - boot 的 `setup` 抛错时，`run()` 不会执行，暂停标志可能沿用上一 tick 的值；但此时 boot 已失败，setup 与业务阶段本来就会跳过，健康状态取 degraded，不受影响；
  - 端口在钩子结束（含抛错）后关闭；被硬终止时，下一 tick 的 `run()` 会先重置开关，再进入业务阶段；
  - 软重置跨实例累计暂停计数；抛错路径仍使用原有冷却。
- **文档**：
  - 改动文档的相对链接与章节锚点全部可解析；
  - 不再有"第 4 步交付前"之类的过期描述；
  - 架构 14.3 的修订与用户同意的范围一致（M1 加入 intershard 的特性检测与本 shard 清空，M5 注明跨 shard 协议）。
- **注释**：新增源文件都有文件摘要；具名函数与对象字面量方法都有 JSDoc；Map 定义旁写明了 key 与 value 的含义。

以下是设计已接受的取舍，不列为问题：

- Memory 实例在整个生命周期内保留加载时的原始文本，最多约 2 Mi 字符，是为了让备份反映迁移或清空前的原貌（`runtime.ts` 的 `text` 字段注释、bootPort 设计第 3 节）；
- 备份区容量约 1 MB，超出时备份失败、不能自动清空（bootPort 设计第 3 节）。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check`（类型检查、单元与边界测试、构建） | 通过；25 个测试套件，324 项测试 |
| `git diff --check`（含未跟踪文件） | 通过 |
| 构建产物 | `dist/main.js` 含 `const release = "0.1.9"` |
| `npm run test:scenarios` | 3 个场景全部通过：fallback-takeover、kernel-smoke、memory-takeover。这些场景每 tick 都经过新的 segments 读写路径，但不调用任何特权操作；备份、清空与初始化的私服验证按设计在第 6 步进行 |
| 临时副本中的复现测试 | 2 项，按"当前实际行为"断言通过，复现 SB-01 与 SB-03；副本位于任务临时目录，工作区的源文件与测试未改动 |

复现测试断言的是当前行为，用于证明问题存在，不作为回归测试交付。SB-01 的影响以装配次数计数确认，没有测量 Screeps CPU。

## 待用户决定

| 编号 | 建议 |
| --- | --- |
| SB-01 | 方案 A：超过暂停上限后的软重置计入抛错，复用冷却 |
| SB-02 | 方案 A：只补文档，由 app.assembly 把版本号同时注入 app.boot |
| SB-03 | 方案 A：`previousEpoch()` 取加载时与当前合法 epoch 的较大者 |

## 整改与复核记录（2026-10-20）

用户决定：三项均按建议整改。整改在同一分支的工作区进行，未提交。

### 整改内容

| 编号 | 整改 | 与建议的差异 |
| --- | --- | --- |
| SB-01 | `src/main.ts` 抽出 `countCrash()`，抛错与"连续暂停超过 `PAUSE_LIMIT` 后仍登记软重置"共用失败计数与冷却；超限期间的暂停 tick 不清零失败计数。冷却告警由"连续 3 次抛错"改为"连续 3 次失败"。同步修改内核设计第 6 节（伪代码、`KERNEL_CRASH_LIMIT` 定义、新增"重置循环"一条）与 bootPort 设计第 3、5 节 | 增加"超限期间不清零失败计数"：实施时发现，只计数而不保持，软重置与普通暂停交替出现时，计数会在中间的暂停 tick 清零，从而绕过冷却。上限内的暂停仍按原规则清零，正常开局流程不受影响 |
| SB-02 | bootPort 设计第 6 节写明：app.assembly 构造 app.boot 时，把同一版本号作为 app 层内部的装配参数传入，不经 contracts，也不放宽边界规则；第 4 节与内核设计第 7 节加上对应说明 | 无 |
| SB-03 | `src/kernel/bootPort/index.ts` 的 `previousEpoch()` 取"加载时标记的 epoch""本实例已签发的 epoch""当前 sys 的 epoch"三者的最大值，不合法的按 0 计；`initialize()` 与 `clearMemory()` 记录已签发的值。bootPort 设计第 3 节增加"epoch 只增不减" | 比建议多一项"本实例已签发的 epoch"：同一实例内第二次清空时，加载时的值已经落后，只取前两项仍可能回退 |

### 回归测试与反向验证

| 编号 | 回归测试 | 反向验证 |
| --- | --- | --- |
| SB-01 | `test/main.test.ts` 新增 2 项：每 tick 都软重置时，300 tick 内装配 19 次（前 10 tick 各 1 次，之后每轮 3 次重建触发一次 100 tick 冷却），上限内不产生报告；软重置与普通暂停交替时仍进入冷却，40 tick 内装配 8 次 | 撤掉修复（恢复每 tick 清零、不计数）后 2 项失败；恢复后 `src/main.ts` 哈希为 `a33bb1c8a835`，与修复后一致，11 项通过。依据为装配次数计数，不依赖耗时 |
| SB-02 | 纯文档修改，没有回归测试 | 不适用；已核对链接与章节引用 |
| SB-03 | `test/kernel/bootPort/bootPort.test.ts` 新增 1 项：原 epoch 6 时写入非法 epoch 后清空得 7；同 tick 两次清空、中间写入非法值得 8；初始化后写入非法值再清空得 2 | 撤掉修复（恢复只读当前值）后该项失败；恢复后 `src/kernel/bootPort/index.ts` 哈希为 `6a369c204b5a`，与修复后一致，18 项通过 |

### 复核验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过；25 个测试套件，327 项测试（新增 3 项），构建成功 |
| `git diff --check`（临时索引包含未跟踪文件） | 通过 |
| `npm run test:scenarios` | 3 个场景全部通过；场景不触发软重置或清空，整改路径由单元测试覆盖 |

整改后的文件哈希（前 12 位）：`src/main.ts` `a33bb1c8a835`，`src/kernel/bootPort/index.ts` `6a369c204b5a`，`test/main.test.ts` `c7fa0b55a48d`，`test/kernel/bootPort/bootPort.test.ts` `bafcadc856ca`，`docs/design/kernel/README.md` `a3530b4a02bf`，`docs/design/kernel/bootPort.md` `533b1001ee5f`。

三项均已关闭，没有遗留问题，也没有需要挂起的问题。
