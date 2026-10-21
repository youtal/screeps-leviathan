# 模块设计：bootPort（boot 特权端口）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/kernel/bootPort/`；清空 InterShardMemory 的平台操作在 `src/kernel/intershard/`（[intershard](./intershard.md)） |
| 架构章节 | 5.5 软重置、5.6 boot 特权端口、6.7 项目标记、11.4 开局、11.8 不可逆操作闸门 |
| 契约 | [contracts](../contracts/README.md#63-boot-特权端口与上下文) 第 6.3 节的 `BootPort`、`BootContext` |
| 成熟度 | 定稿 · M1 |

## 1. 职责

bootPort 为 `BootContext.port` 提供实现，并为 `BootContext.sys` 提供项目标记的访问器。它只执行操作，不理解操作的游戏含义：何时备份、能否清空、写入什么模式，都由 app.boot 依据 11.8 的闸门决定。

端口只在 boot 钩子运行期间有效；其他时候调用任何方法都抛错。

## 2. 契约变更

在 `BootPort` 上增加：

```ts
/**
 * Memory 为 empty（本项目命名空间缺失、加载成功）时加入本项目命名空间，保留其他根键，项目标记由 kernel 生成；
 * 其他状态调用即报错。
 */
initialize(): void;
```

`clearMemory()` 的签名不变。两者都由 kernel 生成项目标记的初值，boot 随后在同一 tick 经 `sys` 写入指纹与模式；同一 tick 内没有提交，两步对外是原子的。

## 3. 操作

| 操作 | 语义 | 前置条件 | 失败 |
| --- | --- | --- | --- |
| `summary()` | 本 kernel 实例加载时原始 Memory 文本的概要：是否为空（11.3 的 EMPTY）、能否解析为对象、根键、本项目命名空间中的项目标记（规则见下） | 无 | 不抛错；平台读取或 JSON 解析失败时 `parsed` 为 false、`marker` 为 null。概要不代表 Memory 能够加载，见下文"概要与加载" |
| `backup()` | 把本 kernel 实例加载时的原始文本写入备份区（页 80–89），写完后回读校验；返回 `pending`、`done` 或 `failed`。重复调用推进进度，完成后保持 `done`。返回 `pending` 的 tick 为暂停 tick | 无 | 文本超过备份区容量（约 1 MB）或回读不一致时返回 `failed` |
| `initialize()` | 在根上加入本项目命名空间，其他根键保持在前；项目标记见第 4 节，`epoch` 为 1 | Memory 为 empty | 状态不符时抛错 |
| `clearMemory()` | 整体替换根为只含本项目命名空间的新根；`epoch` 为原 epoch 加 1（原 epoch 的取法见下文"epoch 只增不减"，无可读标记时为 1）；清除加载失败的锁存。此前发布的所有分区与切片访问器失效 | 本 kernel 实例内普通模块尚未 setup；否则抛错，要求先软重置 | 前置条件不符时抛错 |
| `clearInterShard()` | 清空本 shard 的 InterShardMemory；运行环境没有 InterShardMemory 时什么也不做 | 无 | 平台异常原样抛出 |
| `softReset()` | 登记软重置：本 tick 为暂停 tick，照常提交；入口在下一 tick 开始前销毁 kernel 并重新装配；连续暂停未超过 `PAUSE_LIMIT` 时不计为失败，超过后按失败计数（[内核设计](./README.md#6-入口正常循环与保底循环)）。boot 钩子在同一 tick 抛错时，登记作废 | 无 | 不抛错 |

- **概要的判定规则**：
  - `empty` 按 11.3 的 EMPTY 计算：文本为空白，或根对象的键都属于 `creeps`、`spawns`、`rooms`、`flags`、`powerCreeps` 且值都是没有键的对象（`{}` 是其特例）。
  - `marker` 要求本项目命名空间存在且其 `sys` 的 `sig` 与装配签名相符、`schema` 为非负整数。`schema` 与当前版本相同时，按当前结构完整校验，不合法即为 null；不同时只保证 `sig` 与 `schema` 两个字段，其余字段可能属于其他版本的结构，boot 据此判定 OURS_NEWER，不读取其他字段。这样较新版本改变标记结构时，也不会被误判为 FOREIGN 而失去 11.4 e 的保护。
- **概要与加载**：概要只校验命名空间中的 `sys`；命名空间的字段集合与单元包络在加载时校验。`sys` 合法而其余结构不合法时，`parsed` 为 true，`marker` 为完整的标记，但 Memory 加载失败并锁存，访问 `sys`、`memory`、`rooms`、`creeps`、`flags` 都抛错。boot 以访问 `sys` 抛错识别"标记合法但 Memory 无法加载"；这种情形的判定与处置由 app.boot 的设计规定。schema 低于当前版本的标记同样无法加载（[memory](./memory.md)）。
- **软重置与 boot 失败**：boot 钩子抛错的 tick 不采信判定结果（[内核设计](./README.md#2-tick-流水线)），本 tick 登记的软重置随之作废，kernel 实例保留，下一 tick boot 在同一实例中重新判定。否则"登记软重置后抛错"的 boot 会使入口每 tick 重建 kernel 并完整解析 Memory；这样的 tick 计为 degraded 而不是 paused，不受 `PAUSE_LIMIT` 与冷却的约束。
- **备份内容**：`summary()` 与 `backup()` 都基于本 kernel 实例加载时读到的原始文本，而不是当前内存中的数据，所以迁移或清空之前的备份反映的是迁移前的原貌。软重置后的新实例重新读取已提交的文本。空文本无需备份，直接返回 `done`。
- **备份格式**：按 [segments](./segments.md) 的页格式，store 为 `backup`，数据版本 `v` 为 1，`g` 为快照 tick，`e` 为写出时的 epoch，正文按顺序切分原始文本。回读校验经 `PageReader` 激活备份页，下一 tick 比较拼接结果与快照；不一致时整批重写一次，仍不一致返回 `failed`。
- **备份区容量**：10 页约 1,000,000 字符，小于 Memory 的 2 MB 上限。超出时返回 `failed`，boot 按闸门不清空（11.8 要求已完成备份）。压缩备份不在 M1 范围。
- **清空与软重置**：11.4 规定若判定发生时本 global 已运行过，先软重置。kernel 以“本 kernel 实例的普通模块是否已 setup”作为可检查的条件强制这一顺序：普通模块持有的访问器在清空后全部失效，必须重建。
- **暂停 tick**：备份进行中与登记软重置的 tick，kernel 跳过普通模块 setup 与业务阶段（[内核设计](./README.md#2-tick-流水线)）。所以 Memory 已就绪时（11.4 c），软重置后的新实例在备份完成前不会 setup，备份完成的 tick 仍能清空；判定与清空之间也没有业务模块或保底循环的动作改变开局世界。
- **epoch 的起点**：`initialize()` 与无可读标记的 `clearMemory()` 都从 1 开始，无法得知账号上旧 segment 页使用过的 epoch。Memory 被人工清空或中间运行过其他代码后，上一段生涯中 epoch 同为 1 的页会被当作有效页。M1 的 store 不受影响：备份回读比较正文，统计只写不读。第一个读取 segment 的业务 store（M5 的读调度）设计时须处理这一点。
- **epoch 只增不减**：`clearMemory()` 的原 epoch 取以下三者中的最大值，每项不是非负整数时按 0 计：加载时标记中的 `epoch`、本实例已签发的 epoch（`initialize()` 或之前的 `clearMemory()`）、当前 `sys` 中的 `epoch`。`sys` 的结构校验发生在提交时，boot 写入的非法值在提交前仍留在 heap 中，所以不能只读当前值，否则 epoch 会回退为 1，使上一段生涯中的页被当作当前页（6.8 安全规则 2）。

## 4. 项目标记

`initialize()` 与 `clearMemory()` 生成的初值：

| 字段 | 初值 | 来源 |
| --- | --- | --- |
| `sig`、`schema` | 装配配置的身份 | kernel.memory 的选项 |
| `shard` | 身份用的 shard 名：有 InterShardMemory 时为 `Game.shard.name`，否则（私服）为 `x`（11.3 的 `here`） | `GamePort.shard()` |
| `epoch` | 见第 3 节 | kernel |
| `lastRun` | 当前 tick | GamePort |
| `release` | 构建时注入的版本号 | 装配选项（第 6 节） |
| `fp` | `{rooms: [], spawnIds: [], creepCount: 0}` | 占位，由 boot 写入 |
| `mode` | `{mode: 'AMBIGUOUS', strength: 'medium', since: 当前 tick, evidence: []}` | 占位，由 boot 写入 |

- `sys` 访问器与分区访问器的路径语义相同，在 Memory 为 ready 后可用；empty 时访问抛错。它始终指向当前命名空间的标记，清空后不需要重新取得。
- 写入 `sys` 后，提交时按项目标记的结构校验：`sig`、`schema` 必须与装配身份一致，字段类型合法。校验失败时按单元级隔离处理：沿用上一次合法的标记写出，并经告警端口报告。
- `lastRun`、`release`、`fp`、`mode` 的更新时机（6.7）由 boot 负责，kernel 不自动维护。boot 取得当前版本号的方式见第 6 节。

## 5. 对其他 kernel 模块的要求

| 模块 | 新增能力 |
| --- | --- |
| kernel.memory | 加载时缓存原始文本与概要（`summary()`、`loadedText()`）；`sys()` 访问器；`clear(marker)` 整体替换根并清除失败锁存；现有 `initialize(marker)` 不变 |
| kernel.segments | `backup` store 的写入与回读（[segments](./segments.md)） |
| kernel.intershard | M1 只提供特性检测与 `clearLocal()`（[intershard](./intershard.md)）；跨 shard 协议（6.9）在 M5 交付 |
| kernel.context | `GamePort.shard()` |
| kernel.lifecycle | 在 boot 钩子运行期间开放端口；`clearMemory` 的前置条件检查；暂停 tick 与 `paused` 健康状态；每 tick 调用 `segments.beginTick()` 与 `segments.commit()`；`Kernel.resetRequested()` |
| 入口 main.ts | tick 后检查 `resetRequested()`：为真时销毁 kernel，下一 tick 重新装配；连续暂停未超过 `PAUSE_LIMIT` 时不计入连续失败，超过后计入并共用冷却；`paused` 的计数与 `PAUSE_LIMIT`（[内核设计](./README.md#6-入口正常循环与保底循环)） |

## 6. 版本号注入

`release` 来自构建：rollup 配置用一个内联插件提供虚拟模块 `virtual:release`，导出 `package.json` 的 `version`；app.assembly 读取后作为 kernel 选项传入。不新增依赖。这同时交付架构 13.1 build 的“版本号注入”。

boot 每次 global reset 时更新 `sys.release`（6.7），也需要当前版本号。app.assembly 构造 app.boot 时，把同一版本号作为 app 层内部的装配参数一并传入：不经 contracts，`BootContext` 不增加字段，也不放宽下表的边界规则。kernel 生成的标记初值与 boot 写入的值因此来自同一个来源。

虚拟模块不是磁盘上的文件，类型检查、单元测试与边界检查都需要相应配置：

| 环节 | 配置 |
| --- | --- |
| 类型检查与 rollup 的 TypeScript 插件 | `src/env.d.ts` 声明模块 `virtual:release`，导出 `release: string` |
| Jest | `moduleNameMapper` 把 `virtual:release` 映射到测试替身 `test/stubs/release.ts`，导出固定的版本号 |
| 边界检查 | `virtual:release` 不算外部包，只允许 `src/app/assembly/` 导入；其他位置导入仍报违规 |

## 7. 验证

- 单元测试用严格平台模拟覆盖：端口只在 boot 期间有效；`summary` 对空、引擎默认空对象形状、外来、损坏、同签名同 schema、同签名不同 schema 的文本，以及标记合法而命名空间其余结构不合法时概要给出标记、访问 `sys` 抛错；`initialize` 与 `clearMemory` 的前置条件、标记初值与 epoch；清空后旧访问器失效、`sys` 仍可用；备份的分页、跨 tick 写出、回读校验、超容量与不一致；备份进行中与登记软重置的 tick 不 setup、不运行业务阶段、返回 `paused`；Memory 已就绪时“软重置 → 备份 → 清空”能在新实例中完成；软重置在下一 tick 生效且不计为抛错；boot 抛错时本 tick 的软重置登记作废；连续暂停超过 `PAUSE_LIMIT` 后计为 degraded；`sys` 写入非法标记时的隔离，以及隔离期间备份页头仍取已持久化的 epoch。
- 构建：`npm run build` 的产物包含 `package.json` 的版本号；边界测试覆盖 `virtual:release` 的放行与拒绝。
- 私服场景：开局时的初始化（kernel-smoke）；外来 Memory 经人工确认后的软重置、备份、回读与清空，以及有资产而 Memory 为空时的初始化（boot-judgment）。Memory 丢失后的认领属于 M2 的接手流程（[app.boot](../app/boot.md#43-m1-尚未交付的分支)）。
