# 全项目审计：架构合理性与无用方法

## 基线与范围

- 日期：2026-10-20。
- 基线：`dev` 的 HEAD `077cbc116880311463a50a540a60805442f2000d`（0.1.12，合并 `feat/kernel-observability`）。审计在从该提交拉出的 `docs/project-audit` 分支进行，没有修改代码、测试或设计。
- 范围：
  - `src/` 全部源文件：kernel 的 13 个模块、contracts、lib 的 hash、naming、geometry，app 的 assembly 与 ops，`fallback.ts`、`main.ts`、`settings.ts`；
  - `scripts/` 的部署、版本与场景工具；
  - `test/` 的测试基础设施与覆盖情况；
  - `docs/design/` 与三份章程文件和实现的一致性。
- 重点：架构合理性；过时、无用的方法、字段与配置。
- 依据：架构设计 4.2–4.5、5.1–5.8、6.2–6.6、12.1、13.1、14.3、14.4、15.1；模块设计 [kernel](../design/kernel/README.md)、[cpu](../design/kernel/cpu.md)、[stats](../design/kernel/stats.md)、[memory](../design/kernel/memory.md)、[profiler](../design/kernel/profiler.md)、[console](../design/kernel/console.md)、[ops](../design/app/ops.md)、[contracts](../design/contracts/README.md)。
- 前置检查：
  - [挂起问题列表](./suspended.md)为空。
  - 第 5 步（cpu、console、stats、ops）合并前没有单独的交付审计：索引中与它相关的最近一份是设计阶段的 [lib-core-delivery](./2026-10-20-lib-core-delivery.md)。本报告覆盖第 5 步的实现。
- 方法：
  - 通读源码与相关设计；
  - 用 TypeScript 语言服务统计 `src/` 中每个导出符号与接口成员的引用位置（附录 A）；
  - 在仓库之外用临时 Jest 配置运行复现测试，不在仓库中增加文件（附录 B）；
  - 用脚本核对 `docs/`、`README.md`、`AGENTS.md` 的相对链接与章节锚点，以及源码注释中的设计文档路径。
- 关键文件 SHA-256 前 12 位（下文行号对应这份快照）：

  | 文件 | 哈希 |
  | --- | --- |
  | `src/kernel/lifecycle/index.ts` | `d71b9d1749ef` |
  | `src/kernel/lifecycle/ops.ts` | `df249674e45b` |
  | `src/kernel/cpu/index.ts` | `cbb91e164b7a` |
  | `src/kernel/process/index.ts` | `5cc87ebff975` |
  | `src/kernel/context/index.ts` | `4f7f4ed1b0fa` |
  | `src/contracts/boot.ts` | `2d9d9767305b` |
  | `src/kernel/memory/commit.ts` | `77886d4cdd8d` |
  | `src/kernel/memory/runtime.ts` | `84f9dd5d0e94` |
  | `src/kernel/memory/unit.ts` | `c7c981936a33` |
  | `src/kernel/memory/marker.ts` | `94fc8d4aa907` |
  | `src/kernel/console/index.ts` | `41425eada804` |
  | `src/kernel/logger/index.ts` | `4857cb0b8484` |
  | `src/kernel/profiler/index.ts` | `c67d914822f4` |
  | `src/kernel/stats/index.ts` | `f190a3f3c726` |
  | `src/app/assembly/index.ts` | `63a999a4d60b` |
  | `src/app/ops/index.ts` | `797206559255` |
  | `docs/design/kernel/cpu.md` | `da7daf63d98e` |
  | `docs/design/kernel/README.md` | `a8fd7569829b` |
  | `docs/design/kernel/memory.md` | `205409895656` |
  | `docs/design/app/ops.md` | `544ddd0a8106` |
  | `docs/design/architecture.md` | `0e5641349638` |
  | `README.md` | `ef370d06f49a` |
  | `scripts/deploy/lib.ts` | `f90f62bf00c8` |
  | `scripts/deploy/cli.ts` | `b415d6f01375` |
  | `scripts/version/lib.ts` | `d349677d7361` |
  | `scripts/version/cli.ts` | `a4d97cef6996` |
  | `test/boundary/check.ts` | `a2b1ff234c01` |
  | `test/kernel/lifecycle/harness.ts` | `2e14735c60a2` |
  | `test/scenarios/support/harness.cjs` | `37f8300419c3` |
  | `src/kernel/memory/index.ts` | `278b28e41179` |
  | `.gitignore` | `b95939576003` |

- 修订：同日核实一份外部评审，把成立的问题并入本报告（PA-13 至 PA-21 及若干补充），见文末[修订记录](#修订记录核实外部评审)。
- 本轮约束：只新增本报告并更新审计索引，不修改实现、测试、设计或三份章程，不提交、不合并。

## 结论

**架构总体合理，实现与设计的主体一致；但第 5 步的实现留下一个会使维护层实例停摆的执行缺陷，部署工具的自动回滚会选错目标。Memory 提交与可观测性各有一处会随规模放大的缺口，版本工具与发布流程的衔接也有缺口。**

合理之处（第"架构合理性评估"节逐项说明）：

- 分层、依赖与持久化边界由边界测试静态检查，`src/` 没有违规；
- contracts 只放声明，按使用方分阶段加入；
- 保底循环独立，257 行有效代码，低于 400 行的上限；
- `npm run check` 通过：33 个测试套件，397 项测试，构建成功。

无用方法：

- 没有零引用的导出；
- 生产代码中没有读取方的方法与字段集中在 profiler 的快照、console 命令表的两个字段、Memory 单元的 `space` 字段与提交时计算的 `owners`；
- 另有两项"有实现、无启用途径"的配置开关（PA-04）。

确认 2 项 P2、6 项 P3、11 项 P4，另有 2 项范围外问题：

| 编号 | 级别 | 类别 | 问题 |
| --- | --- | --- | --- |
| PA-01 | P2 | 范围内修正 | 维护层动态实例只在与所属模块相位重合的 tick 运行，约九成实例永不运行；准入（cpu）与执行（lifecycle）对"模块空闲时实例是否运行"的处理不一致 |
| PA-02 | P3 | 简化（运行成本） | Memory 每次有写入的提交都对全部单元重新转义键名、重建索引键：只有 1 个脏单元时也调用 `JSON.stringify` 约"单元数 × 2 + 实体数"次 |
| PA-03 | P3 | 范围内修正 | 候选优化的数据触发条件缺少观测量：commit 的 CPU 没有测量，按模块的体积已算出却不写入统计 |
| PA-04 | P3 | 范围内修正 | 架构所说的"开发构建"没有对应的构建配置：Memory 抽样比对（15.1 的防范措施）与实例计时都无法启用 |
| PA-05 | P3 | 范围内修正（契约） | `BootContext` 继承的进程表与 `onDispose` 不生效，契约承诺了 kernel 不提供的行为 |
| PA-06 | P4 | 范围内修正 | 只 `optional` 依赖环成员的模块被连带拒绝；互为 `optional` 的两个模块都被拒绝 |
| PA-07 | P4 | 简化 | 没有生产使用方的方法与只写不读的字段 |
| PA-08 | P4 | 范围内修正、简化 | 同一事实在多处硬编码：保留模块 id、运营模式集合、日志级别、收尾预留公式等 |
| PA-09 | P4 | 范围内修正（测试） | 进程表的 `remove`、`has` 与 `ModuleContext.instance` 没有任何测试 |
| PA-10 | P4 | 范围内修正（文档） | 设计文档与实现不一致或格式缺陷：内核设计第 6、7 节，ops 设计的 `ops.status(id)`，cpu 设计 3.3 节的表格 |
| PA-11 | P4 | 章程（须你的指令） | README 与架构设计中的进度类陈述已过时 |
| PA-12 | — | 范围外 | 仓库卫生：5 个已合并分支的遗留 worktree、`.gitignore` 的旧规则、引号风格不统一 |
| PA-13 | P2 | 范围内修正（部署工具） | 自动回滚只按版本号选目标，会切到从未生效的版本分支，或已知有问题的版本 |
| PA-14 | P3 | 范围内修正（版本工具） | `check:version` 不区分合并方向：跨里程碑的发布合并与同步合并被拒绝，发布时误 bump 不被发现 |
| PA-15 | P3 | 章程（须你的指令）或第 6 步设计 | 首个 spawn 由玩家命名、保底 creep 不带签名，早期殖民地丢失 Memory 时签名比例达不到 SELF_ADOPT 的阈值 |
| PA-16 | P4 | 范围内修正 | `beginTick` 抛错（例如 tick 倒退）后 kernel 仍按就绪运行：持久化停止，健康状态却为 ok |
| PA-17 | P4 | 范围内修正 | Memory 体积越过告警线后每次提交都告警；超过上限后每 tick 重新拼装并记录错误 |
| PA-18 | P4 | 范围内修正（版本工具） | 构建产物变化的判定漏判两种情形：文件移出 `src/`，以及 `overrides` 变化 |
| PA-19 | P4 | 范围内修正（边界检查） | 边界检查允许任何 app 模块导入 `settings.ts`，架构 4.3 只允许 app.assembly 与 main.ts |
| PA-20 | P4 | 新增 API 或功能 | 版本分支只增不减，会触及服务器的分支数上限，部署工具没有清理手段 |
| PA-21 | — | 范围外 | 既有注释缺陷：装配与测试辅助模块中的 JSDoc 缺口，场景辅助模块摘要中的路径错误 |

分级沿用以往报告：

- **P2**：会在已规划的使用方接入后导致功能失效或错误操作的缺陷；
- **P3**：可以延后、但应记录处置的潜在问题、运行成本问题或流程阻碍；
- **P4**：文档缺口，或只在调用方违反约定、罕见条件下出现的边角问题。

目前没有业务模块（模块清单为空，boot 为临时实现），以上问题都没有线上影响。

- PA-01 在 M2 第一个带动态实例的维护层模块（建造、修复、库存控制等）接入时生效；
- PA-05 在第 6 步实现 app.boot 时可能被触及，PA-15 是第 6 步 app.boot 设计的输入；
- PA-13、PA-14、PA-20 涉及的工具尚未在官服使用，触发点在 M1 的官服发布演练或 M2 的首次发布。

## 架构合理性评估

| 方面 | 评价 | 关联问题 |
| --- | --- | --- |
| 分层与依赖 | 与 4.1、4.2 一致。边界测试（[check.ts](../../test/boundary/check.ts)）检查层间依赖、领域隔离、`@/` 别名、外部包、持久化全局与原生 `memory` 的访问、lib 的模块级状态，以及 `settings.ts` 与 `fallback.ts` 的特殊边界；基线上没有违规。`settings.ts` 的导入方只按层检查，比 4.3 宽 | PA-19 |
| 契约 | contracts 只含声明，按第一个使用方加入；`segments`、`services`、core 切片与 `admit` 已在 contracts 设计第 7 节列为待加入。`BootContext` 直接继承整个 `ModuleContext`，范围过宽 | PA-05 |
| 进程表与准入 | 拓扑排序、隔离、熔断、启停与预算准入的设计完整，单元测试充分。缺陷出在"模块—实例"关系被两处分别编码：kernel.cpu 按设计让实例在模块空闲时准入，lifecycle 的执行循环仍要求模块准入 | PA-01、PA-06、PA-09 |
| 持久化 | 接管、单元级标脏、隔离、待确认文本、迁移与回收的语义经过多轮审计，覆盖充分。提交的拼接成本与 6.2"只对脏单元执行 `JSON.stringify`"的意图有差距，会随单元总数线性放大。`beginTick` 的失败没有反映到 `ready()` 与健康状态；体积告警没有去重 | PA-02、PA-16、PA-17 |
| 可观测性 | 统计页覆盖 kernel 的主要指标。缺少 kernel 自身收尾工作的耗用与按模块的体积，使 14.4 的数据触发机制在 Memory 候选上无法以数据判断；profiler 收集计时但没有读取方 | PA-03、PA-07 |
| 工程 | 构建、部署、版本、场景测试的工具链完整，部署工具不在消息中输出令牌。13.1 的"环境配置"没有落地，架构中依赖"开发构建"的机制无法启用。部署工具用版本号顺序代替生效历史；版本工具不区分合并方向，构建变化的判定有漏判；边界检查对 settings 的导入方只按层判断 | PA-04、PA-13、PA-14、PA-18、PA-19、PA-20 |
| 保底与入口 | 保底不导入项目模块，不读写持久化；入口的冷却、暂停上限、接管通知与入口状态都与内核设计第 6 节一致 | — |
| 启动判定（第 6 步） | 11.6 的签名比例把玩家命名的首个 spawn 与保底 creep 计入分母，早期殖民地达不到 SELF_ADOPT 的阈值 | PA-15 |
| 文件规模 | 用"去掉空行与以 `//`、`/*`、`*` 开头的行"统计，`src/` 与 `scripts/` 中最大的是 `kernel/lifecycle/index.ts`（275 行）与 `fallback.ts`（257 行），都没有超过 300 行的建议值 | — |

`createKernel`（[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L110)）同时承担 kernel 的组装与 tick 流水线。目前规模可控，拆分没有运行收益，本报告不建议重构。

## 问题

### PA-01 · P2 · 维护层动态实例只在与所属模块相位重合时运行

**类别：范围内修正。证据：测试复现、源码核实。**

- **来源**：[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L309) 第 309 行。阶段循环在模块的判定结果不是"准入"时 `continue`，而第 325–335 行的实例循环嵌套在这一判断之后。因此模块未被准入时，它的全部实例都被跳过，不看实例自己的判定结果。
- **与设计及 kernel.cpu 的分歧**：
  - [cpu.md](../design/kernel/cpu.md#31-准入单位) 第 46 行：所属模块空闲（例如维护层周期未到）时，实例仍可准入。第 71 行：被准入的进程运行全部阶段。第 84 行特别说明：维护层的模块与实例按各自的进程键错峰，相位一般不同；若要求依赖在同一 tick 运行，依赖方只会在相位重合的 tick 运行。
  - kernel.cpu 按此实现：[cpu/index.ts](../../src/kernel/cpu/index.ts#L198) 第 198–202 行按每个进程自己的键判断维护周期；第 226 行只有所属模块"落选"才阻挡实例，"空闲"不阻挡。
  - 这条规则来自 LC-02 的整改（见 [lib-core-delivery](./2026-10-20-lib-core-delivery.md) 的整改记录）。整改只改了准入判定，执行侧仍是"模块准入才执行实例"的结构。
- **传播**：
  - 维护层模块在 `(Game.time + hashString(模块 id)) % 10 === 0` 的 tick 准入，实例在 `(Game.time + hashString(进程键)) % 10 === 0` 的 tick 准入。
  - 实例要运行，两个条件必须同时成立，即两个哈希对 10 同余。其余实例永远不运行。
  - 这些实例的判定结果仍是"准入"：连续落选次数归零（第 233 行），stats 的准入计数包含它们，`ops.status()` 中模块状态为"运行"、实例熔断数为 0。没有任何日志或告警，属于静默停摆。
- **影响**：
  - 架构 5.2 把建造、修复、Lab、Factory、库存控制列为维护层。M2 起这类按殖民地或站点派生的实例，若哈希均匀分布，约九成不会运行（比例是推断）。
  - 这一缺陷不影响经济层与规划层：这两层的模块与实例层条件相同，模块空闲时实例也空闲。
- **复现**（附录 B 的 R1）：维护层模块 `m` 带一个相位不同的实例 `b`，运行 40 tick。模块钩子运行 4 次，实例钩子 0 次，按设计应为 4 次。同样结构的经济层实例每 tick 运行。
- **测试缺口**：[cpu.test.ts](../../test/kernel/cpu/cpu.test.ts) 的"依赖空闲不阻挡"只断言 `admit` 的判定结果；lifecycle 的测试没有维护层实例。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 阶段循环把"模块钩子是否执行"与"实例是否执行"分开：模块钩子按模块的判定执行；实例按自己的判定执行（准入，或本 tick 新增的未判定实例）。只去掉"模块判定为准入"这一条件：模块在本阶段不可运行（熔断、依赖暂停）时仍跳过它的实例；模块落选已由 kernel.cpu 传递为实例落选 | lifecycle 的阶段循环约 10 行；补 lifecycle 层的回归测试。含义上，模块作者不能假设维护层实例运行的 tick 本模块的钩子也运行；cpu.md 第 84 行已是此意，可在 contracts 第 2 节补一句 |
| B | 实例沿用所属模块的维护相位（层条件按模块 id 判断） | 同一模块的实例集中在同一 tick 运行，失去 12.2 的错峰效果，CPU 峰值随实例数增长；须修订 cpu.md；不建议 |

### PA-02 · P3 · Memory 每次有写入的提交都对全部单元重新转义键名

**类别：简化（运行成本），依据为调用计数。证据：测试复现、源码核实。**

- **来源**：[commit.ts](../../src/kernel/memory/commit.ts#L103) 第 103–115 行。每次有写入的提交，都遍历全部空间、实体与单元：
  - 第 107 行对每个单元调用 `unitId(space, parent, key)`，即 [runtime.ts](../../src/kernel/memory/runtime.ts#L156) 第 156 行的 `JSON.stringify([space, parent, key])`，再查单元表；
  - 第 21–22 行的 `objectText` 对每个键调用一次 `JSON.stringify(key)`，实体名与切片 owner 都在内；
  - 每个单元分配一个 `[key, encoded]` 元组，每条实体分配 `Object.keys` 与 `map` 的结果数组。
- **与设计的差距**：
  - 架构 6.2（第 415 行）："commit 时只对脏单元执行 `JSON.stringify` 并缓存结果，再与其他单元的缓存串拼接成根串"。单元的值确实只编码脏单元，但键名转义与索引键对全部单元重做，没有缓存。
  - 12.1 的禁止项包括热路径上的链式 `map`。提交在每个有写入的 tick 执行一次，工作量随单元总数增长。
  - commit.ts 第 26–27 行的注释已指出"脏提交并非 O(脏单元数)"。拼接整个根串是 `RawMemory.set` 的要求，无法避免；键名转义和索引键的重建则不是。
- **计数**（附录 B 的 R4）：n 个 creep 切片中只有 1 个脏单元时，一次提交调用 `JSON.stringify` 3n + 7 次（n = 100 时 307 次，n = 1000 时 3007 次）。其中：
  - n 次是索引键；
  - 2n 次是键名转义：n 条实体各 1 次，n 个切片各 1 次；
  - 编码脏数据只有 1 次，其余 6 次是命名空间与根的键。
  - 一般地，次数约为"单元数 × 2 + 实体数"，与脏单元数无关。
- **影响**：
  - creep 的任务字段几乎每 tick 都变（6.2 第 416 行），所以几乎每个 tick 都要做一次这样的提交。
  - 例：100 个 creep、每个 3 个模块切片，每 tick 约 700 次短字符串或短元组的 `JSON.stringify`，外加约 800 个短命数组（每个单元的元组与索引键数组，每条实体的 `Object.keys` 与 `map` 结果）。它们计入 5.3"kernel 与 world 的固定开销 ≤ 1.5 CPU/tick"的预算，GC 时间也计入 CPU（12.1）。实际 CPU 须在游戏内测量，本报告不以 Node 耗时推算。
  - 不影响正确性：拼接结果与全量 `JSON.stringify` 一致，已有 Memory 测试覆盖。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 单元登记时缓存它的键片段（已转义的 `"<key>":`），并让拼接按根表结构直接取得单元（例如实体记录与分区表持有单元引用），不再用 `unitId` 查表；拼接改为普通循环与字符串累加。持久格式、接口与编码结果不变 | 每个单元多一个字符串字段的 heap；改动集中在 commit.ts 与 runtime.ts。反向验证以 `JSON.stringify` 的调用次数为依据：修复后应为"脏单元数 + 常数" |
| B | 实施 14.4 候选的分级缓存：缓存每条实体记录与每个空间的拼接结果，只重拼有变化的部分 | 属于候选，须满足 [memory.md](../design/kernel/memory.md#1-触发条件) 第 1 节的触发条件并经你同意；且触发条件目前无法观测（PA-03） |
| C | 维持现状，M2 线上实测后再定 | 无实现成本；规模增长后成本随之增长 |

### PA-03 · P3 · 候选优化的数据触发条件缺少观测量

**类别：范围内修正（观测缺口）；按分区的脏写频率属于新增功能。证据：源码核实。**

- **机制**：架构 14.4（第 1580–1590 行）规定，候选优化只有在统计数据满足触发条件时才实施。Memory 块级优化的三个触发条件见 [memory.md](../design/kernel/memory.md#1-触发条件) 第 128–130 行。
- **逐条现状**：

  | 触发条件 | 需要的数据 | 现状 |
  | --- | --- | --- |
  | 主 Memory 文本总长度超过 300 KB | 总长度 | 统计页的 `memory.total` 已写出 |
  | commit 阶段序列化 CPU 的 7 日均值超过预算的 5% | commit 的 CPU | 没有测量。[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L428) 第 428–432 行在 `maintain` 与 `commit` 前后不读 CPU；统计页的 `cpu.tiers` 只含业务钩子，`cpu.avg` 是总耗用（第 437 行），kernel 收尾、boot 与 setup 混在两者的差值里；profiler 也不为 kernel 自身计时 |
  | 单个分区的脏写频率与体积之积进入前 5%，且体积超过 20 KB | 每个分区的体积与脏写频率 | 没有。commit 第 100、110 行按 owner（不是按分区）累计体积，发布在 `SizeSnapshot.owners`（[runtime.ts](../../src/kernel/memory/runtime.ts#L80) 第 80 行），但没有任何读取方；统计页只写 `total` 与 `spaces`（[lifecycle/ops.ts](../../src/kernel/lifecycle/ops.ts#L371) 第 371–375 行，[stats.md](../design/kernel/stats.md#2-指标) 第 30 行）。脏写频率没有记录 |

- **与架构的差距**：6.6（第 483 行）写"各命名空间、各模块的体积可 O(1) 取得并写入统计"。模块体积已经算出，但没有写入统计。
- **影响**：
  - 后两个条件无法用数据判断，候选只能凭第一个条件或人工判断来触发，背离 14.4 "由数据触发"的原则；
  - `owners` 在每次有写入的提交中逐单元累加并冻结成新对象，却没有读取方；
  - M2 按 5.3 校准"kernel 与 world 的固定开销"时，也缺少 kernel 收尾工作的单独数据。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | （1）lifecycle 在 Memory 维护之前读一次 CPU，与统计采集时的读数相减，得到 kernel 收尾（维护与提交）的耗用，写入统计页的 `cpu`；（2）把 `owners` 中体积最大的若干个写入统计页的 `memory`，与 6.6 一致。同步 stats 设计第 2、3 节的字段 | 每 tick 多 1 次 `Game.cpu.getUsed()`；统计正文略增。外部采集端尚未建立，没有兼容负担 |
| B（新增功能） | 按分区记录脏写次数，满足第三个触发条件 | 需要新的计数状态；建议等 M2 出现大分区再议 |
| C | 删除 `owners` 的计算，并在 memory.md 注明后两个条件暂时无法观测 | 与 6.6 的要求不符；不建议 |

### PA-04 · P3 · "开发构建"没有对应的构建配置

**类别：范围内修正（须决定启用方式）。证据：源码核实。**

- **规定**：
  - 架构 6.3（第 439 行）："开发构建在 commit 时对未标脏的单元做抽样哈希比对，以发现违规修改"；15.1（第 1611 行）把它列为"通过只读引用直接修改 Memory"的处理措施；
  - 13.1（第 1467 行）的 build 交付物包含"环境配置"；
  - memory.md 第 76 行："开发期可配置每次提交轮转校验若干未标脏单元"；
  - profiler.md 第 16 行："实例级明细是否计时由 kernel 的配置决定"。
- **现状**：
  - Memory 的 `auditUnits`（[runtime.ts](../../src/kernel/memory/runtime.ts#L57) 第 57 行，commit.ts 第 45–55 行）只在单元测试的宿主中设置（`test/kernel/memory/harness.ts` 第 33 行）。装配（[assembly/index.ts](../../src/app/assembly/index.ts#L171) 第 171 行）不传，游戏中恒为 0。
  - `KernelOptions.profileInstances`（[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L60) 第 60 行）装配不传，测试也没有启用。第 331 行的实例计时分支在生产与测试中都没有执行过。
  - 构建只有一种（`rollup.config.mjs`），不区分开发与发布；`src/settings.ts` 只有日志设置；app.profiles（14.3 的 M1 交付物）尚未建立。
- **影响**：
  - 15.1 列出的防范措施在任何运行环境中都不存在，违反只读约定的修改只能在单元测试中发现，私服场景测试也不开启；
  - 两项开关都是"有实现、无启用途径"的配置；
  - 实例计时分支没有测试。启用时每次实例钩子调用都要截取进程键并查找实例上下文（第 331 行），不是零分配路径。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 在 `src/settings.ts` 增加使用者设置（例如 Memory 的抽查数与 kernel 的实例计时，默认关闭），由装配注入；私服调试与场景测试时手动开启。实例计时改为由实例记录直接持有 `Measure`，并补测试 | 在 `contracts/settings.ts` 增加两个类型（契约变更，须你确认）；装配约 2 行；lifecycle 小改 |
| B | rollup 增加构建变体（由环境变量选择），场景测试使用开发构建 | 工作量更大；场景测试与发布产物不再是同一构建 |
| C | 确认两项只服务单元测试：删除 `profileInstances`，修订架构 6.3、15.1 的"开发构建"表述 | 修订章程，须你的指令；15.1 的风险失去运行期防范 |

### PA-05 · P3 · BootContext 继承的进程表与清理函数不生效

**类别：范围内修正（契约收窄，须你确认）。证据：测试复现、源码核实。**

- **来源**：
  - [contracts/boot.ts](../../src/contracts/boot.ts#L96) 第 96 行 `BootContext extends ModuleContext`，boot 因此取得 `processes`、`instance`、`onDispose` 等全部模块能力。
  - [contracts 设计](../design/contracts/README.md#3-上下文)第 102 行把 `onDispose` 写为"软重置时调用"；[内核设计](../design/kernel/README.md#4-上下文)第 134 行写"在软重置或入口重建时按登记顺序调用"。
  - kernel 为 boot 单独建立运行记录（[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L188) 第 188–189 行），它不在 `runtimes` 中。阶段循环（第 307 行）与 `dispose`（第 467 行）都只遍历 `runtimes`。
- **传播与影响**：
  - boot 经 `onDispose` 登记的清理函数永远不会被调用；
  - boot 经 `processes.add` 添加的实例永远不会被调度，销毁时也不调用其 `dispose`；
  - 两者都没有错误或日志。第 6 步实现 app.boot 时一旦使用，会静默失效。boot 继承的能力中确实生效的是 `console`（[console 设计](../design/kernel/console.md#3-契约变更)第 40 行）、日志、计时与 Memory。
  - 实际后果有限：boot 的 heap 状态在闭包中，随 kernel 实例一起丢弃；现有能力中没有必须靠 `onDispose` 释放的外部状态。问题在于契约承诺了 kernel 不提供的行为。
- **复现**：附录 B 的 R2，两项测试都失败：清理函数调用 0 次，实例钩子调用 0 次。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | `BootContext` 改为在去掉 `processes` 与 `instance` 的模块上下文之上扩展（例如 `Omit<ModuleContext, 'processes' \| 'instance'>`）；kernel 的 `dispose` 同时调用 boot 运行记录登记的清理函数，使 `onDispose` 的语义与模块一致 | contracts 变更，须你确认；lifecycle 约 3 行；补测试 |
| B | 保持类型，只在 contracts 设计中注明 boot 的 `processes` 与 `onDispose` 无效 | 类型仍允许误用；不建议 |

### PA-06 · P4 · optional 依赖指向依赖环成员的模块被连带拒绝

**类别：范围内修正。证据：测试复现。**

- **来源**：[process/index.ts](../../src/kernel/process/index.ts#L88) 第 88–89 行的 `ready` 要等待 `optional` 依赖排好；而环成员要到排序循环结束后才记为拒绝（第 100–102 行）。因此只 `optional` 依赖环成员的模块永远排不进去，同样以"处在依赖环上，或依赖了成环的模块"被拒绝。只由 `optional` 构成的环（两个模块互为 `optional`）两方都被拒绝。
- **与设计**：
  - [contracts 设计](../design/contracts/README.md#2-模块定义与阶段钩子)第 42 行：`optional` 是软依赖，只影响拓扑排序；
  - [内核设计](../design/kernel/README.md#31-静态模块排序)第 96 行：只拒绝有问题的模块及经 `requires` 依赖它的模块。前一种情形违反这条隔离规则。
  - 后一种情形，第 99 行的"处在依赖环上"没有区分 `requires` 与 `optional`，按字面成立；但两个模块本身都能运行。
- **影响**：只在清单出现依赖环（配置错误）或 `optional` 互指时出现；启动时记录日志，不会静默失效。
- **复现**：附录 B 的 R3。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 先只按 `requires` 检测依赖环，拒绝环成员及 `requires` 它们的模块，再排序；排序时 `optional` 只等待最终会被排入的模块，`optional` 构成的环按"层级 → priority → id"打破 | 约 10 行；补两项测试；同步内核设计第 3.1 节 |
| B | 保持实现，在内核设计第 3.1 节写明这两种情形也会被拒绝 | 只改文档；隔离规则出现例外 |

### PA-07 · P4 · 没有生产使用方的方法与只写不读的字段

**类别：简化（逐项给出依据）；其中一项的处置涉及新增功能。证据：引用统计（附录 A）、源码核实。**

全部导出符号都有引用，没有零引用的导出。下表是生产代码中没有读取方的方法与字段：

| 位置 | 成员 | 现状 | 建议 |
| --- | --- | --- | --- |
| [console/index.ts](../../src/kernel/console/index.ts#L67) 第 67–68 行 | 命令表项的 `get`、`set` | 注册设置时写入（第 232 行），从未读取：安装访问器时直接使用参数，桩对象也不用它们；只用 `fn` 是否存在来区分命令与设置 | 删除两个字段，或改为布尔字段标明"设置"；收益很小，属于去掉死数据 |
| [memory/unit.ts](../../src/kernel/memory/unit.ts#L17) 第 17 行 | `Unit.space` | 登记单元时写入（runtime.ts 第 251 行、sys.ts 第 42 行），`src/` 中没有读取 | 删除；单元数随"creep 数 × 切片数"增长，每个单元少一个字段 |
| [memory/runtime.ts](../../src/kernel/memory/runtime.ts#L80) 第 80 行 | `SizeSnapshot.owners` | 每次有写入的提交都计算，没有读取方 | 见 PA-03：写入统计（建议），而不是删除 |
| [logger/index.ts](../../src/kernel/logger/index.ts#L82) 第 82、304 行 | `LogRoot.defaults()` | 只有测试读取（`logger.test.ts`、`ops.test.ts`） | 保留：它是 `setDefault` 的配对查询，测试据此验证 `ops.log`，没有运行成本 |
| [profiler/index.ts](../../src/kernel/profiler/index.ts#L56) 第 56、58 行 | `Profiler.snapshot()`、`overflow` 与 `ProfileEntry` | 只有测试读取。[profiler.md](../design/kernel/profiler.md#职责与边界) 第 14 行说明 M1 没有读取快照的使用方，接口留给后续的诊断命令；每次模块钩子调用仍为它多读一次 CPU（cpu.md 第 116 行） | 维持现状：设计已认可，M1 没有业务模块，成本为零。新增 `ops.profile()` 输出快照属于新增功能，建议等 M2 出现诊断需求时再议 |
| [lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L60) 第 60 行 | `KernelOptions.profileInstances` | 没有启用途径，没有测试 | 见 PA-04 |

此外：

- 58 个导出只在本文件内使用（附录 A），其中 36 个是接口、类型别名与类，多为选项与宿主接口（如 `KernelOptions`、`ConsoleOptions`）；其余 22 个是常量与函数（如 `BUCKET_TARGET`、`TIER_RANK`、`moduleState`）。导出本身没有运行成本，类型导出还承担接口说明的作用，不建议批量改动。
- lib.geometry 的 9 个函数与 lib.naming 的 `formatName`、`verifyName` 只有测试使用。它们是 14.3 列入 M1 的交付物，使用方随 M2 的 spawnQueue、接手判定与 movement 等交付，不属于无用代码。

### PA-08 · P4 · 同一事实在多处硬编码

**类别：范围内修正（防止漂移）与简化。证据：源码核实。**

| 事实 | 位置 | 风险 |
| --- | --- | --- |
| 保留模块 id | [process/index.ts](../../src/kernel/process/index.ts#L21) 第 21 行的字面量表；各 owner 的使用处另行硬编码：lifecycle/index.ts 第 167、188、457 行的 `'boot'`，memory/entities.ts 第 43 行的 `'core'`，lifecycle/ops.ts 第 28 行的 `KERNEL_OWNER`，app/ops/index.ts 第 100 行的 `'ops'` | 新增或改名时漏改一处，保留表与实际 owner 不一致，模块可能与 kernel 分区或宿主命名空间冲突 |
| 运营模式集合 | [memory/marker.ts](../../src/kernel/memory/marker.ts#L24) 第 24–25 行的 `MODES` 与 contracts/mode.ts 的 `BootMode` | 新增模式时校验仍拒绝，合法的项目标记被判为不合法；可以用以 `BootMode` 为键的对象加 `satisfies` 在编译期发现遗漏 |
| 日志级别 | app/ops/index.ts 第 43 行的 `LEVELS` 与 logger/index.ts 第 30 行的 `LOG_LEVELS` | 漂移时 `ops.log` 与 logger 接受的级别不一致；app 可以直接导入 `LOG_LEVELS` |
| 收尾预留 | [assembly/index.ts](../../src/app/assembly/index.ts#L146) 第 146 行的 `Math.max(2, game.limit() * 0.1)`，与 cpu/index.ts 第 28–29、252 行的 `max(RESERVE_MIN, B × RESERVE_RATIO)` | 数字重复，而且基数不同：errorMapper 用 `limit`，cpu 用 B。[errorMapper.md](../design/kernel/errorMapper.md#源码映射) 写"本 tick 剩余 CPU 低于收尾预留时"不映射，bucket 高时两者结果不同。可以导入 cpu 的两个常量，并在设计中写明基数 |
| 统计页号 | stats/index.ts 第 18 行的 `STATS_PAGE` 与 segments/index.ts 第 37 行的 `STORES.stats.pages` | 只改一处时写入返回 `not-owned`，统计被丢弃；风险低 |
| 非负整数判断 | memory/marker.ts 第 36 行、segments/index.ts 第 165 行、segments/page.ts 第 33 行各有一份 `isCount` | 一行函数，没有漂移风险；不建议为此增加跨模块依赖 |

建议前四项改为单一来源：保留 id 由各 owner 的常量组成或在一处导出；模式集合加编译期约束；ops 导入 `LOG_LEVELS`；errorMapper 的余量改用 cpu 的常量并写明基数。后两项维持现状。

### PA-09 · P4 · 进程表与实例上下文的公共接口没有测试

**类别：范围内修正（测试）。证据：测试检索、临时测试。**

- 在 `test/` 中检索 `processes.remove`、`processes.has` 与 `.instance(`，都没有调用：
  - `ProcessTable.remove` 与 `ProcessTable.has`（[contracts/context.ts](../../src/contracts/context.ts#L63) 第 63–83 行）；
  - `ModuleContext.instance`（第 108 行）。
- 维护层实例经 lifecycle 执行的路径也没有测试，PA-01 因此漏过；`profileInstances` 分支同样没有测试（PA-04）。
- 临时测试确认前三项的当前行为正确（附录 B 的 R5）：
  - 阶段中移除实例时立即调用其 `dispose`，从下一个钩子起停止调度；
  - `has` 随之变化；
  - `instance(key)` 返回缓存的同一对象，`key` 为完整进程键。
- **影响**：M2 的业务模块大量依赖动态实例（4.4、5.1），这些接口是第一批使用方的必经路径。
- **建议**：在第 6 步或 M2 第一个使用方之前补上述测试，与 PA-01 的回归测试一起提交。

### PA-10 · P4 · 设计文档与实现不一致或格式缺陷

**类别：范围内修正（文档）。证据：文档与源码核实。**

1. [内核设计](../design/kernel/README.md#7-装配第-2-步的临时内容)第 190–198 行（第 7 节）：标题与内容仍是"第 2 步的临时内容"。第 194 行写 Memory 配置"取自 `app.config`"，实际取自 assembly 的 `MEMORY_IDENTITY`（[assembly/index.ts](../../src/app/assembly/index.ts#L28) 第 28 行，注释说明 app.config 建立后迁入）。
   此外，这一节是 app.assembly 的设计，却写在 kernel 的设计中（内核设计第 5 行的源码列表也包含 `src/app/assembly/`）。架构 1.5 与[设计索引](../design/README.md)要求模块设计与源码目录一一对应，同一层内跨模块的设计写在该层的 README。app.assembly 正式化时（第 6 步加入 app.boot 的装配），应把这部分移到 `docs/design/app/` 下。
2. 内核设计第 177 行（第 6 节）的末句"这需要对已合并的 Memory 模块做一处配套修改，随内核实现一并交付"是实施过程的记录。按 README 的文档规范，设计文档不记录历史。
3. [ops 设计](../design/app/ops.md#2-命令)第 20 行：`ops.status(id)` 是"一个模块及其实例的明细"。实现（[app/ops/index.ts](../../src/app/ops/index.ts#L102) 第 102–108 行）只输出该模块的一行汇总（实例数与熔断数），没有实例明细。建议把文档改为"一个模块的状态行"；实现实例明细属于新增功能。
4. [cpu 设计](../design/kernel/cpu.md#33-kernel-自身的任务)第 93–99 行（3.3 节）：表格被第 98 行的段落截断。第 99 行"stats 采集与写出"紧接段落，按 GFM 会并入段落，成为普通文本。应把该行移回表格，段落放在表后。

### PA-11 · P4 · 章程文件中的过时陈述

**类别：章程修订，须你针对相应文件给出指令（AGENTS.md 第 2 节）。证据：文档核实。**

| 文件 | 位置 | 过时内容 | 建议 |
| --- | --- | --- | --- |
| `README.md` | 第 5 行 | "私服场景测试待建立"：场景测试已在 0.1.9 建立（`npm run test:scenarios`） | 改为不随进度过时的写法，例如只保留指向里程碑的链接 |
| `README.md` | 第 19 行 | "私服场景测试命令建立后在本节补充"：命令已存在，但"开发命令"代码块没有列出，只在第 147 行的"验证与发布"中出现 | 在代码块中补 `npm run test:scenarios`（需要 Docker，`-- --only <场景名>` 只运行单个场景），删去这句 |
| `docs/design/architecture.md` | 第 7 行 | 状态"设计定稿，待实施"：M1 已实施到第 5 步 | 改为"定稿"并去掉进度字样，或改为"定稿，M1 实施中" |
| `docs/design/architecture.md` | 第 59 行 | 1.5 节表中 `kernel/memory.md` 的说明为"Memory 块级标脏与分级序列化缓存（候选）"；该文档现在同时包含 Memory v1 的设计，设计索引写作"Memory v1 与候选块级优化" | 同步说明 |

### PA-12 · 范围外 · 仓库卫生

**类别：范围外问题，只报告。证据：Git 与文件系统检查。**

- **遗留 worktree**：`git worktree list` 列出 5 个注册的 worktree：
  - `.claude/worktrees/deploy`、`.claude/worktrees/runtime-and-deps`、`.claude/worktrees/toolchain`；
  - `../screeps-leviathan-tsconfig-alias`；
  - `/tmp/leviathan-architecture-consensus`。

  对应的 5 个分支都已合并入 `dev`。`.claude/` 已被忽略，不影响构建。删除 worktree 是删除操作，是否清理由你决定。
- **`.gitignore` 的旧规则**：`test/integration/.cache/`、`test/integration/profiles/`、`server`、`.venv/`、`.tscache/`、`.nyc_output`、`coverage` 指向当前仓库中不存在的目录或不再使用的工具。场景测试位于 `test/scenarios/`，并且在容器内运行。这些规则疑为旧项目遗留。
- **引号风格**：`contracts/boot.ts`、`contracts/mode.ts`、`kernel/logger/index.ts`、`kernel/memory/json.ts` 使用双引号与另一种换行风格，其余文件使用单引号；仓库没有格式化或 lint 配置。统一需要引入工具（新增依赖须你同意）或一次性手工统一。

### PA-13 · P2 · 自动回滚只按版本号选目标

**类别：范围内修正（部署工具）；README 中 `rollback` 的说明须随之修订，属于章程，须你的指令。证据：函数复现、源码核实。**

- **来源**：
  - [deploy/lib.ts](../../scripts/deploy/lib.ts#L333) 第 327–350 行 `rollbackTarget`：在全部版本分支中，取"版本号低于当前生效分支的最大者"；
  - [deploy/cli.ts](../../scripts/deploy/cli.ts#L165) 第 165–170 行：打印目标后立即切换，不需要确认；
  - [README.md](../../README.md#部署) 第 31 行把命令描述为"切回上一个版本分支"，与实现一致。
- **与设计**：
  - 架构 13.3 第 1503 行："把生效分支切回上一版本（一步完成）"；第 1499 行的私服回归以"上一版本 → 新版本 → 回滚到上一版本"为准。两处的"上一版本"都指此前在线运行的版本。
  - 服务器只为当前生效分支记录 `activeWorld` 标记，不记录历史（backend 3.3.0 `lib/game/api/user.js` 第 195–207 行的 `set-active-branch`），工具因此用版本号顺序代替生效历史。
- **复现**（附录 B 的 R6，直接调用 `rollbackTarget`）：
  1. M1 按 14.1（第 1550 行）在官服上传非生效分支做发布演练，演练版本分支（例如 `v0.1.15`）留在服务器上，账户原有代码在 `default` 等非版本分支。M2 首个版本 `v0.2.0` 生效后回滚，结果为 `v0.2.0 → v0.1.15`：演练版本从未在官服运行；真正的上一版 `default` 不是版本分支，永远不会被选中。
  2. `v0.2.4` 出问题后已回滚到 `v0.2.3`；热修复 `v0.2.5` 生效后又出问题，再次回滚得 `v0.2.5 → v0.2.4`，切回已知有问题的版本。
- **影响**：
  - 回滚是闭环运行基线被破坏时的应急手段（13.3、14.1），自动选错目标会延长或扩大故障。
  - 情形 1 中，M1 的构建没有业务模块。按本基线的临时 boot，健康状态为 `ok`，保底循环不会接管（见"M1 完成度"），殖民地实际停止运营；第 6 步之后的 M1 构建是否报告 degraded，取决于 app.boot 的判定，是待验证推断。
  - 两个版本之间改变过持久结构时，切回未经两步迁移（13.3）的旧版本会使其判为 OURS_NEWER，进入 AMBIGUOUS。
- **测试**：[deploy.test.ts](../../test/scripts/deploy.test.ts#L129) 第 129–137 行固定的正是"按版本号选上一个"的行为。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 部署工具在本地按账户记录生效历史：每次 `activate`、`upload --activate`、`rollback` 成功后，追加一条记录（时间、切换前的生效分支、切换后的分支）。切换前的分支在切换时从分支列表读取，所以第一次切换也能记下账户原来的 `default`。文件不进入版本控制。`rollback` 以"切换到当前生效分支的那条记录"中的切换前分支为目标，可以是非版本分支；找不到记录时拒绝自动回滚，提示用 `activate` 指定 | 新增一个本地状态文件；换机器部署时历史不共享，由"找不到记录时拒绝"兜底；README 的命令说明需修订 |
| B | 保留版本号排序，但 `rollback` 只打印候选，须用 `--branch` 确认后才切换 | 回滚变为两步，与 13.3 的"一步完成"不一致 |
| C | 不改代码，只修订 README 与运维手册：写明自动回滚按版本号选择；M2 首次发布前删除官服上的演练分支；二次回滚须人工指定 | 依赖运维纪律，紧急时容易遗漏 |

### PA-14 · P3 · 版本校验不区分合并方向

**类别：范围内修正（版本工具）；README 第 176 行的表述修订须你的指令。证据：临时 Git 仓库端到端复现、源码核实。**

- **来源**：
  - [version/lib.ts](../../scripts/version/lib.ts#L138) 第 128–170 行 `checkVersion`：只要正在合并且改变了构建产物，就要求相对 HEAD"同一里程碑内 c 增大，或 b 加 1 且 c 归零"；
  - [version/cli.ts](../../scripts/version/cli.ts#L99) 第 99–117 行：以 HEAD 的版本为基准，只判断 `MERGE_HEAD` 是否存在，不区分合并方向，也不读取 `MERGE_HEAD` 的版本。
- **规则依据**：
  - README 第 178 行："发布到 `master` 的合并……都不改版本号。发布到 `master` 时直接为当前版本打标签"；
  - AGENTS 第 72 行：合并提交在提交前运行 `npm run check:version`。
- **复现**（附录 B 的 R7，临时 Git 仓库中运行仓库的 `scripts/version/cli.ts check`）：

  | 情形 | 结果 | 按规则应为 |
  | --- | --- | --- |
  | 发布：master 0.1.11 ← dev 0.2.3 | 拒绝，"版本号跳变不符合规则：0.1.11 → 0.2.3"，退出码 1 | 通过（等于 dev 的版本） |
  | 发布：master 0.1.5 ← dev 0.1.11 | 通过，理由是"版本号 0.1.5 → 0.1.11" | 通过 |
  | 同上，但发布时误执行 bump，工作区为 0.1.12 | 通过 | 拒绝（应保持 0.1.11） |
  | 同步：任务分支 0.1.11 ← dev 0.2.2 | 拒绝 | 通过 |

- **影响**：
  - M2 的第一次发布（master 仍是 0.1.x，dev 已是 0.2.x）会在 AGENTS 规定的检查中失败，此后每次跨里程碑的发布都如此；
  - 发布时误执行 bump 不会被发现，`master` 的标签与 dev 的版本号随之不一致。
- **相关的表述差异**：README 第 176 行写热修复"取 `dev` 与 `master` 中最大的 `c` 再加 1"，而 `nextVersion`（第 73–89 行）只比较同一 a.b 下的版本。dev 已进入下一里程碑时两者结果不同：master 0.2.3、dev 0.3.9 时，按 README 的字面为 0.2.10，按工具为 0.2.4。工具的做法同样能避免重名，问题在 README 的字面表述。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | cli 按合并方向选规则：当前分支为 master、`MERGE_HEAD` 是 dev 的提交（发布）时，要求工作区版本等于 `MERGE_HEAD` 的版本；合并进 master 的热修复，以及合并进 dev 的任务，沿用现有规则；其他目标分支（同步合并）要求版本等于两个父提交中较大的版本 | cli 增加读取 `MERGE_HEAD` 与当前分支名的逻辑及测试；规则依赖分支命名约定 |
| B | 增加 `check --release`，由操作者在发布合并时显式选择规则 | 依赖人工选择；README 与 AGENTS 的命令说明需修订 |

README 第 176 行的热修复表述，建议改为"同一 a.b 下，取 `dev` 与 `master` 中最大的 `c` 再加 1"，须你的指令。

### PA-15 · P3 · 首个 spawn 与保底 creep 不带签名，早期殖民地的签名比例偏低

**类别：章程（架构 11.6、附录 C）的设计输入，属于第 6 步 app.boot 的待答问题；修订须你的指令。证据：平台源码核实；比例为推导。**

- **平台事实**：
  - backend 3.3.0 `lib/game/api/game.js` 第 328–349 行的 `place-spawn` 直接使用请求中的 `name`，只校验为字符串且不超过 50 个字符；名称由玩家在界面中填写；
  - F1（架构第 1636 行）：只有玩家没有任何房间对象时才能放置 spawn。所以每段生涯（开局或重生后）的第一个 spawn 都由玩家命名，不带本系统的签名。
- **架构**：
  - 9.2 第 784、794 行：签名格式用于"正常流程创建的 creep 与 spawn"，spawn 名称在创建流程中分配；第 796 行：保底名称采用 5.7 的独立格式，不要求正常签名；
  - 11.6 第 1347 行：σ 的分母包含全部 creep 与 spawn；第 1353 行：σ ≥ θ_SELF 才判为 SELF_ADOPT，θ_SELF 为 0.8（附录 B 第 1691 行）；
  - 附录 C 第 1713 行：用例 11 假设 RCL5 房间的签名比例为 1.0。
- **推导**：
  - 本系统的殖民地至少有一个不带签名的 spawn。只有这一个 spawn 时，带签名的 creep 数 k 须满足 k/(k+1) ≥ 0.8，即 k ≥ 4，才能判为 SELF_ADOPT；
  - 早期（RCL 1–3）丢失 Memory、只有 1–3 个 creep 时，σ 为 0.5–0.75，落入情形 c：判为 TAKEOVER，禁止破坏性操作，并通知人工；
  - 保底循环运行期间生成的 creep 同样不带签名。丢失 Memory 前后若保底循环运行过，σ 还会更低（推断）；
  - RCL5 以后通常有数十个 creep，σ 仍高于阈值；但用例 11 的"1.0"在由开局发展而来的殖民地中达不到。
- **影响**：早期丢失 Memory 时走保守的接手路径并等待人工，而不是由本系统直接认领。情形 c 不执行破坏性操作，不会造成资产损失。它影响第 6 步 app.boot 判定的正确性，以及附录 C 测试向量的设计。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | σ 只统计 creep，没有 creep 时才统计 spawn；保底格式的名称既不算带签名，也不计入分母。spawn 都是本方的 OwnedStructure，名称能提供的归属信息有限。同步修订 11.6 与附录 C 用例 11 | 只有 1–2 个 creep 时样本很小，σ 波动更大；需要章程修订授权 |
| B | 不改 11.6，在 app.boot 设计中写明早期殖民地会判为 TAKEOVER（情形 c），并把用例 11 改为实际能达到的比例 | 早期丢失 Memory 时需要人工确认；修改附录 C 同样需要章程修订授权 |

### PA-16 · P4 · beginTick 抛错后 kernel 仍按就绪运行

**类别：范围内修正（kernel.lifecycle 与 kernel.memory 的衔接）。证据：测试复现、源码核实；触发条件为待验证推断。**

- **来源**：[memory/runtime.ts](../../src/kernel/memory/runtime.ts#L294) 第 294 行在 tick 倒退时抛错。此时既没有更新 `facts`，也没有复位 `written`（第 302–303 行），失败也不锁存。
- **传播**：
  - [lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L397) 第 397–401 行捕获异常，本 global 内只记录一次"Memory 不可用，本 global 内所有模块都无法读写持久数据"；
  - 第 416 行的 `memory.ready()`（[memory/index.ts](../../src/kernel/memory/index.ts#L135) 第 135 行）只看实例是否销毁、是否加载失败、数据是否存在，仍为 true；第 350 行的健康判定只看 `memory.failed()`；
  - 于是业务阶段、维护与提交照常运行。提交时上一 tick 的 `written` 仍为 true，抛出"同一 tick 只能提交一次"（[commit.ts](../../src/kernel/memory/commit.ts#L58) 第 58 行），由 lifecycle 第 431 行每 tick 记录一次"Memory 提交失败"。
- **复现**（附录 B 的 R8）：以 tick 100、101、102、50、51、52 驱动带一个生存层模块的 kernel，模块每 tick 写一次分区：
  - 6 个 tick 的健康状态都是 `ok`，act 钩子运行 6 次；
  - 持久文本中的值停在 tick 102 写入的值；
  - "Memory 不可用"记录 1 次，"Memory 提交失败"记录 3 次。
- **影响**：
  - 同一 global 内世界时间倒退时，heap 照常修改，Memory 不再持久化。入口看到 ok，不会追加保底循环；
  - 时间追上原值后恢复写入，期间若发生 global reset，倒退期间的修改全部丢失；
  - 日志声称"所有模块都无法读写"，实际上模块仍在运行。
- **触发条件（待验证推断）**：官服回档，或私服恢复数据库，而玩家 VM 没有回收时（F6：VM 只在代码更新、isolate 销毁或闲置超过 3 分钟时回收）。架构 9.2 第 793 行声明"服务器时间回滚或重建不在此保证内"，但那一条针对的是命名唯一性，不覆盖 Memory。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | lifecycle 记录本 tick 的 `beginTick` 是否成功；失败时跳过 setup、业务阶段、维护与提交，计为 degraded，由入口按 `SAFE_MODE_TICKS` 追加保底 | 增加一个本 tick 标志与测试；时间倒退期间只有 boot 与保底循环运行，直到时间追上原值 |
| B | memory 把时间倒退视为新的时间线：接受新 tick，丢弃相邻 tick 的缺席证据，把记录的创建 tick 截到当前 tick，并告警一次 | 改变 memory 设计中"拒绝时间倒退"的约定，回收逻辑需相应调整与测试 |
| C | A 与 B 同时实施：B 处理时间倒退，A 兜底其他 `beginTick` 异常 | 两处改动的成本之和 |

### PA-17 · P4 · Memory 体积告警每次提交都触发

**类别：范围内修正（kernel.memory）。证据：测试复现、源码核实。**

- **来源**：
  - [commit.ts](../../src/kernel/memory/commit.ts#L128) 第 128 行：候选文本不少于 1.8 Mi 字符时，每次提交都调用告警；
  - 第 129 行：超过 2 Mi 字符时抛错，lifecycle 第 431 行每 tick 记录一次错误；
  - 装配把告警接到 memory 作用域的 warn 日志（[assembly/index.ts](../../src/app/assembly/index.ts#L171) 第 171 行）。
- **复现**（附录 B 的 R9）：写入一个 1.85 Mi 字符的分区后每 tick 修改一个字段，20 次提交产生 20 条告警；超过上限后的 11 次提交全部重新拼装候选文本并抛错，都没有写入。
- **影响**：
  - creep 的任务几乎每 tick 都在变化，几乎每 tick 都有提交。Memory 接近上限后，控制台每 tick 一条告警；
  - 超过上限后，每 tick 重新拼装约 2 Mi 字符的候选文本再抛错，并记录一条错误；
  - 控制台输出计入 CPU，也会淹没其他日志。架构 6.6 第 483 行要求"超过告警线时通知"，13.4 第 1525 行规定 Memory 体积的告警渠道是看板。统计页已有 `memory.total`（[lifecycle/ops.ts](../../src/kernel/lifecycle/ops.ts#L373) 第 373–374 行），看板可以据此告警。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 越过告警线时告警一次，回落到告警线以下（可加少量滞回）后才允许再次告警；超限错误同样只在进入超限时记录一次 | commit 增加一个实例内状态 |
| B | 按 tick 间隔限频，例如每 1000 tick 至多一次 | 多一个参数；持续超限时仍周期性刷日志 |

### PA-18 · P4 · 构建产物变化的判定有两处漏判

**类别：范围内修正（版本工具）。证据：临时 Git 仓库复现、源码核实。**

- **来源**：
  - [version/cli.ts](../../scripts/version/cli.ts#L106) 第 106 行用 `git diff --name-only HEAD` 列出改动文件；
  - [version/lib.ts](../../scripts/version/lib.ts#L96) 第 96–99 行按路径前缀判断；
  - 第 113–126 行的 `dependencyChanged` 只比较 `dependencies` 与 `devDependencies`。
- **复现**（附录 B 的 R10）：
  - 任务分支把 `src/a.ts` 移到仓库根目录，合并进 dev 时：Git 默认开启重命名检测，`git diff --name-only HEAD` 只列出 `moved.ts`，加 `--no-renames` 才同时列出 `src/a.ts`；check 输出"合并未改变构建产物，版本号保持 0.1.11"并通过；
  - 只改 `overrides` 的合并同样判为未改变构建产物。
- **影响**：
  - 把文件移出 `src/` 时构建产物已经改变，check 却要求版本号保持不变；
  - `package.json` 的 `overrides`（现用于 js-yaml 3 的 argparse，见[依赖审计](./2026-10-17-dependencies.md)）会改变实际安装的依赖版本，也不触发判定。README 第 179 行的"依赖声明"是否包括 `overrides`，没有写明。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 改用 `git diff --name-only --no-renames HEAD`；经你确认 `overrides` 属于依赖声明后，`dependencyChanged` 一并比较 `overrides` | 两处小改动与测试 |
| B | 不改，接受这两种边角情形 | 无 |

### PA-19 · P4 · 边界检查允许任何 app 模块导入 settings

**类别：范围内修正（边界检查）。证据：测试复现、源码核实。**

- **来源**：
  - 架构 4.3 第 190 行规定 `settings.ts`"只被 `app.assembly` 与 `main.ts` 导入"；
  - [check.ts](../../test/boundary/check.ts#L57) 第 57–69 行的 `ALLOWED` 中 app 为 `'any'`，settings 的导入方只按层判断；
  - 文件摘要第 11 行与 [boundary.test.ts](../../test/boundary/boundary.test.ts#L98) 第 98 行也写作"只有 app 与 main 可以导入它"。
- **复现**（附录 B 的 R11）：虚拟文件 `app/ops/index.ts` 与 `app/boot/index.ts` 导入 `@/settings`，不报违规；同样的导入放在 `kernel/console/index.ts`，报 layer 违规。
- **影响**：第 5 步交付的 app.ops，以及第 6 步的 app.boot、app.config 都在 app 层，可以直接读取 settings 而不被发现，绕开"由装配方作为参数注入"的约定（架构 4.2、4.3）。目前 `src/` 中只有 app.assembly 导入它。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 仿照 `virtual:release` 的导入方限制（`RELEASE_IMPORTER`），把 settings 的导入方限定为 `app/assembly/` 与 `main.ts`，并补测试 | 数行检查与测试 |
| B | 修订架构 4.3 为"只被 app 层与 main.ts 导入" | 需要章程修订授权；约束放宽 |

### PA-20 · P4 · 版本分支持续累积，没有清理手段

**类别：新增 API 或功能，由你决定是否纳入。证据：平台源码核实。**

- **平台**：backend 3.3.0 `lib/game/api/user.js` 第 227–228 行，`clone-branch` 在账户已有 30 个分支时返回 `too many branches`（`tutorial-<数字>` 除外）。官服的上限未核实。
- **工具**：
  - 每次发布都新建一个 `v<版本号>` 分支（[deploy/cli.ts](../../scripts/deploy/cli.ts#L113) 第 113–118 行）；
  - 命令集（[deploy/lib.ts](../../scripts/deploy/lib.ts#L45) 第 45–53 行）没有删除分支的命令，README 的部署一节也没有说明清理流程。
- **影响**：发布若干次后，`upload` 因分支数已满而失败，只能到游戏界面手工删除。手工删除同时决定了哪些版本还能作为回滚目标，与 PA-13 相关。
- **建议**：在 M2 运维手册中写明分支保留策略，例如保留最近 N 个曾经生效的版本分支；是否增加清理命令由你决定。

### PA-21 · 范围外 · 既有注释缺陷

**类别：范围外的既有注释缺口，按 AGENTS 第 3 节只报告，由你决定是否批量补充。证据：源码核实。**

README 第 77 行要求 `src/`、`scripts/` 及测试辅助模块中所有具名函数与方法，包括对象字面量方法，都写 JSDoc；传给 `map`、`test` 等的内联匿名回调除外。发现以下缺陷：

- [assembly/index.ts](../../src/app/assembly/index.ts#L144) 第 144、146、152 行：`createErrorMapper` 选项中的 `loadMap`、`remaining`，以及 `createLogRoot` 选项中的 `format`，没有 JSDoc；同一文件中 `GamePort` 的同类属性都有。
- [lifecycle 测试宿主](../../test/kernel/lifecycle/harness.ts#L42) 第 42、64–66、68 行：
  - 日志选项的 `sink`、`time`、`format`；
  - 平台端口的 `read`、`write`、`warn`；
  - `GamePort` 的 `time`、`cpuUsed`、`tickLimit`、`limit`、`bucket`、`shard`、`flagNames`；
  - profiler 的 `cpuUsed`。

  同一文件中的 `segments`、`setActive` 有 JSDoc。
- [场景辅助模块](../../test/scenarios/support/harness.cjs#L67) 第 67 行的具名箭头函数 `allowed` 没有 JSDoc；第 4 行的摘要写"由 test/scenarios/*.scenario.cjs 使用"，实际的场景文件是 `test/scenarios/scenarios/*.scenario.js`（[scenarios/lib.ts](../../scripts/scenarios/lib.ts#L14) 第 14 行 `USAGE` 的说法是正确的）。
- 边界情形：`src/fallback.ts` 第 161 行 `room.find` 的 `filter` 与第 457 行 `PathFinder.search` 的 `roomCallback`，是传给引擎 API 的选项回调，与上面的选项对象方法属于同一类。

建议：补齐；或在 README 中写明"传给工厂或引擎 API 的选项对象中的内联箭头函数"是否属于例外（README 属于章程，须你的指令）。

## 观察（不列为问题）

- **构建产物中的注释**：
  - 0.1.12 的 `dist/main.js` 有 182,623 个字符，其中注释 64,641 个，占 35.4%（用 TypeScript 语法树统计），去掉注释后为 117,982 个；
  - `main.js` 与 `main.js.map` 合计约 367 KB（233,801 与 133,246 字节）。backend 的 `POST /api/user/code` 限制模块表 JSON 不超过 5 MB（`lib/game/api/user.js` 第 84–85 行），其中包括 `main.js.map` 模块，目前离上限很远；
  - README 要求详细注释，代码规模增长后，产物体积和 global reset 时的编译成本都会随注释增长。建议在 M2 测量 global reset 首 tick 的 CPU 后，再决定是否在构建中去掉注释（source map 仍能映射行号）。
- **errorMapper 的真实堆栈**：
  - [errorMapper 设计](../design/kernel/errorMapper.md)第 46 行要求在私服场景中复核真实堆栈格式，现有三个场景都没有断言映射结果；
  - driver 5.2.7 `lib/runtime/runtime-driver.js` 第 23 行以模块名为文件名，第 67 行把代码包在同一行的前缀 `(function __module(module,exports){ ` 中。所以 `main:<行>:<列>` 的行号不变，只有第 1 行的列有偏移；产物第 1 行是 `'use strict';`，不影响映射；
  - 以上结论来自源码分析，仍待场景验证。

## 已核对事项

以下各项已核实，没有发现问题：

- **边界**：边界测试覆盖 4.2 的全部可静态检查的规则；`fallback.ts` 不导入项目模块，只以 `typeof InterShardMemory` 做特性检测；`settings.ts` 目前只被 app.assembly 导入（检查本身对 4.3 的导入方限制不完整，见 PA-19）。
- **lib**：三个模块没有模块级可变状态，只依赖 lib 与 contracts。
- **kernel.cpu**：预算、收尾预留、四层的层条件、先判定依赖、落选衰减与预热，与 cpu 设计一致（执行侧的问题见 PA-01）。
- **kernel.console**：安装、冲突处理、桩对象与离线命令与 console 设计一致。
- **kernel.stats**：窗口聚合、写出间隔、截短重试与 stats 设计一致。
- **入口**：冷却、暂停上限、软重置计数、接管通知的频率限制、入口状态与内核设计第 6 节一致。
- **进程表**：`remove`、`has`、`instance` 的行为正确（只是没有测试，见 PA-09）。
- **工程脚本**：
  - 部署工具只校验被选中的账户，消息不含令牌；
  - source map 以 `main.js.map` 模块上传并去掉 `sourcesContent`，与 errorMapper 的 `require('main.js.map')` 一致；
  - 版本工具的 bump 规则（task、milestone、hotfix）与 README 的版本号规则一致；check 的问题见 PA-14、PA-18；
  - 场景运行器禁网、只读根文件系统、去掉全部能力、非 root 运行。
- **部署 API**（backend 3.3.0 `lib/game/api/user.js`）：
  - `POST /code` 只覆盖已存在的分支，不存在时返回 `branch does not exist`（第 110–111 行），与 `planUpload` 的新建或覆盖划分一致；
  - 以 `$` 开头的分支名表示生效分支别名（第 94 行），部署工具的 `BRANCH_PATTERN` 已排除；
  - 模块名中的 `.` 在存储时转为 `$DOT$`，读取与运行时（driver 5.2.7 `lib/runtime/data.js` 第 169 行）转回，`main.js.map` 的往返与回读校验成立。
- **平台语义**（engine 4.3.2、driver 5.2.7）：
  - engine `src/game/game.js` 第 479–499 行：每 tick 重新定义可配置的惰性 `Memory` 访问器，所以入口的接管每 tick 都有效；
  - engine `src/game/creeps.js` 第 100–118 行：creep 的 `memory` 读写全局 `Memory.creeps`，接管后落在临时对象上；
  - driver `lib/runtime/runtime.js` 第 250–268 行：tick 结束时保存 `RawMemory.segments` 中的全部键，最多 10 个、值为不超过 100 KB 的字符串，不检查激活集；
  - driver `lib/runtime/make.js` 第 200–202 行：`setActiveSegments([])` 产生的空数组为真值，撤销激活确实生效。
- **版本历史**：dev 第一父链上的 16 个合并中，改动了 `src/` 或构建配置的 12 个都递增了 c，没有改动的 4 个都没有递增，与 README 的规则一致。
- **文档**：`docs/`、`README.md`、`AGENTS.md` 的相对链接与章节锚点全部可解析（脚本核对）；源码注释中引用的设计文档都存在。
- **无用代码**：`tsc --noUnusedLocals --noUnusedParameters` 对 `src/` 没有报告；没有零引用的导出。

## M1 完成度（参考）

按架构 14.3 的 M1 交付清单，基线上的状态如下（只陈述事实，不作为问题）：

| 类别 | 已交付 | 尚未交付 |
| --- | --- | --- |
| kernel | lifecycle、process、cpu、context、memory、segments、intershard、logger、profiler、errorMapper、stats、console、bootPort | — |
| lib | geometry、hash、naming | collections、tables、body |
| app | assembly（boot 为临时实现）、ops | config（M1 部分）、profiles、boot |
| 其他 | 保底循环 | — |
| 工程 | build、deploy、unit、platformFakes（Memory 与 segment）、scenarios（3 个场景）、boundary | platformFakes 的 InterShardMemory 与市场（13.1 第 1470 行）、chaos、inspector；部署、分支切换与回滚的私服演练 |

M1 的验收标准（放置 spawn 后正确判定开局、混沌测试中保底循环接管、部署演练）尚未满足，要等第 6、7 步。临时 boot 不初始化 Memory、模块清单为空：当前产物在任何房间里都不会运营，而 kernel 的健康状态为 `ok`，保底循环不会接管。14.1 规定 M1 在官服只上传到非生效分支，所以这不构成风险，但第 6 步之前不应切换任何生效分支。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check`（类型检查、单元与边界测试、构建） | 通过；33 个测试套件，397 项测试，构建成功 |
| `tsc -p tsconfig.json --noUnusedLocals --noUnusedParameters` | 没有报告 |
| 导出符号与接口成员的引用统计（附录 A） | 完成；成员统计中的解构读取与按名动态索引（如 `hooks[name]`）不计为引用，已逐项人工复核 |
| 复现测试（附录 B，仓库之外的临时配置） | R1、R2、R3 按预期失败，复现 PA-01、PA-05、PA-06；R4 给出 PA-02 的计数；R5 通过 |
| 文档链接与锚点 | 全部可解析 |
| `git diff --check` | 通过（本报告与索引） |
| `npm run test:scenarios` | 未运行：本报告的结论都不依赖引擎行为。PA-01、PA-05、PA-06 是 kernel 内部逻辑，PA-02 是调用计数，均以单元级宿主复现；PA-02 的 CPU 影响须在游戏内测量 |
| 修订时重跑 `npm run check` | 通过；33 个测试套件，397 项测试，构建成功（同一基线） |
| 修订时的复现（附录 B 的 R6–R11） | R6 直接调用 `rollbackTarget`；R7、R10 在临时 Git 仓库中运行仓库的 `scripts/version/cli.ts`；R8、R9、R11 用与 R1–R5 相同的仓库外 Jest 配置。全部按外部评审的描述复现 |
| 平台源码核实 | `npm pack` 下载 engine 4.3.2、driver 5.2.7、backend 3.3.0，在仓库之外解包，只读核对 |
| 构建产物的注释统计 | 用 TypeScript 语法树收集 `dist/main.js` 的注释区间并去重，按行统计（5149 行中 2089 行为注释）交叉核对 |

证据性质：

- **测试复现**：PA-01、PA-05、PA-06、PA-09、PA-13、PA-14、PA-16、PA-17、PA-18、PA-19；PA-02 的调用次数也是测试复现，CPU 影响的规模估计是待验证推断；
- **源码、平台源码或文档核实**：PA-03、PA-04、PA-07、PA-08、PA-10、PA-11、PA-12、PA-15、PA-20、PA-21；
- **推断**：PA-01 中"约九成实例不运行"按哈希均匀分布估计；PA-13 中第 6 步之后的 M1 构建被回滚后的行为；PA-15 中早期殖民地的 creep 数与保底 creep 的影响；PA-16 的触发条件。

## 待用户决定

| 编号 | 建议 |
| --- | --- |
| PA-01 | 方案 A：执行侧按实例自己的判定结果运行实例；补 lifecycle 层回归测试 |
| PA-02 | 方案 A：缓存单元的键片段并按根表结构取单元，以 `JSON.stringify` 调用次数做反向验证 |
| PA-03 | 方案 A：统计页增加 kernel 收尾耗用与按模块体积的前若干项；按分区的脏写频率（方案 B）留待 M2 |
| PA-04 | 方案 A：经 `src/settings.ts` 提供两项开关，需要你确认 `contracts/settings.ts` 的类型变更 |
| PA-05 | 方案 A：收窄 `BootContext`，`dispose` 调用 boot 的清理函数；需要你确认 contracts 变更 |
| PA-06 | 方案 A：先按 `requires` 检测依赖环，`optional` 不再连带拒绝 |
| PA-07 | 删除命令表项的 `get`、`set` 与 `Unit.space`；`owners` 随 PA-03 处理；其余维持 |
| PA-08 | 保留 id、模式集合、日志级别、收尾预留四项改为单一来源 |
| PA-09 | 补进程表与实例上下文的测试 |
| PA-10 | 按第 1–4 条修正设计文档 |
| PA-11 | 需要你针对 README 与架构设计给出修订指令 |
| PA-12 | 范围外；是否清理 worktree 与 `.gitignore`、是否引入格式化工具由你决定 |
| PA-13 | 方案 A：本地记录生效历史，回滚到上一个生效分支，没有历史时拒绝自动回滚；README 的 `rollback` 说明需要你的修订指令 |
| PA-14 | 方案 A：check 按合并方向区分发布、同步与任务合并；README 第 176 行的热修复表述需要你的修订指令 |
| PA-15 | 方案 A：σ 只统计 creep 且不计保底格式的名称，没有 creep 时再统计 spawn；需要你修订架构 11.6 与附录 C 的指令，或选择方案 B 在第 6 步的 app.boot 设计中处理 |
| PA-16 | 方案 A：`beginTick` 失败的 tick 跳过业务阶段并计为 degraded |
| PA-17 | 方案 A：体积告警与超限错误只在越线时记录一次 |
| PA-18 | 方案 A：使用 `--no-renames`；`overrides` 是否算依赖声明，由你确认 |
| PA-19 | 方案 A：把 settings 的导入方限定为 app.assembly 与 main.ts |
| PA-20 | 新增功能：是否增加分支清理命令，或只在 M2 运维手册中规定保留策略 |
| PA-21 | 范围外；是否补齐所列 JSDoc 与摘要，或在 README 中明确选项对象方法的例外 |

## 附录 A　导出符号的引用统计

统计方法：以 `tsconfig.test.json` 建立 TypeScript 语言服务，对 `src/` 中每个导出的函数、类、接口、类型别名与变量调用 `findReferences`，按引用所在位置归类。共 236 个导出：

| 归类 | 数量 | 说明 |
| --- | --- | --- |
| 生产代码中被其他文件引用 | 135 | — |
| 只在本文件与测试中引用 | 31 | 多为测试需要的常量（如 `MAINTENANCE_PERIOD`、`STATS_INTERVAL`）、lib 的辅助函数与类型 |
| 只在本文件内引用 | 58 | 28 个接口、7 个类型别名、1 个类与 22 个常量或函数，如 `KernelOptions`、`moduleState`、`resolveProcess`、`consoleSink` |
| 只在测试中引用 | 12 | lib.geometry 的 9 个函数、lib.naming 的 `formatName` 与 `verifyName`，以及 `main.ts` 的 `loop`（由游戏运行时调用） |
| 没有任何引用 | 0 | — |

接口成员的统计另行进行：只有读取或调用计为引用，实现处的成员声明不计。解构读取与按名动态索引不被识别为引用，结果逐项人工复核，结论并入 PA-07。

## 附录 B　复现测试

复现测试放在仓库之外的临时目录，用以下 Jest 配置运行（`rootDir` 指向仓库，只匹配临时目录中的测试，映射与仓库的 `jest.config.js` 相同）：

```js
module.exports = {
  rootDir: '<仓库>',
  roots: ['<临时目录>'],
  testEnvironment: 'node',
  testMatch: ['<临时目录>/**/*.test.ts'],
  transform: { '^.+\\.ts$': ['<仓库>/node_modules/ts-jest', { tsconfig: '<仓库>/tsconfig.test.json', diagnostics: false }] },
  moduleNameMapper: { '^virtual:release$': '<仓库>/test/stubs/release.ts', '^@/(.*)$': '<仓库>/src/$1', '^(\\.{1,2}/.*)\\.js$': '$1' },
};
```

各测试的核心内容（`kernelHarness` 来自 `test/kernel/lifecycle/harness.ts`，`harness` 与 `marker` 来自 `test/kernel/memory/harness.ts`）：

**R1（PA-01）**：维护层实例在 40 tick 内的运行次数。

```ts
expect(hashString('m') % MAINTENANCE_PERIOD).not.toBe(hashString('m:b') % MAINTENANCE_PERIOD);
const mod: ModuleDefinition = { id: 'm', tier: 'maintenance', priority: 0,
  setup: (ctx) => { ctx.processes.add('b', () => ({ plan: () => { calls.push('inst'); } }));
    return { plan: () => { calls.push('mod'); } }; } };
const h = kernelHarness({ modules: [mod] });
for (let i = 0; i < 40; i += 1) h.tick();
// 结果：mod 4 次，inst 0 次；对照组（经济层）实例 10 tick 运行 10 次
```

**R2（PA-05）**：boot 的 `onDispose` 与动态实例。

```ts
const boot: BootDefinition = { setup: (ctx) => {
  ctx.onDispose(() => disposed.push('boot'));
  ctx.processes.add('x', () => ({ plan: () => { calls.push('x'); } }));
  return { boot: () => undefined }; } };
const h = kernelHarness({ modules: [], boot });
h.tick(); h.tick(); h.tick(); h.kernel.dispose();
// 结果：disposed 为空数组，calls 为空数组
```

**R3（PA-06）**：清单规划。

```ts
planModules([
  { id: 'a', tier: 'economy', priority: 0, requires: ['b'], setup },
  { id: 'b', tier: 'economy', priority: 0, requires: ['a'], setup },
  { id: 'c', tier: 'economy', priority: 0, optional: ['a'], setup },
]); // 结果：a、b、c 都被拒绝
planModules([
  { id: 'd', tier: 'economy', priority: 0, optional: ['e'], setup },
  { id: 'e', tier: 'economy', priority: 0, optional: ['d'], setup },
]); // 结果：d、e 都被拒绝，order 为空
```

**R4（PA-02）**：一次提交的 `JSON.stringify` 调用次数。

```ts
// tick 1：initialize，n 个 creep 各建一个切片并提交（全量编码）
// tick 2：只修改 c0 的切片，jest.spyOn(JSON, 'stringify') 后提交
// 结果：n = 100 时 307 次（其中 3 元组 100 次），n = 1000 时 3007 次（其中 3 元组 1000 次）
```

**R5（PA-09）**：进程表接口的当前行为。

```ts
// 实例 a 记录 plan、act、dispose；实例 b 在 plan 中 remove('a')
// 结果：调用顺序为 a.plan、b.plan、a.dispose、b.act；has('a') 为 false；instance('b') 两次返回同一对象，key 为 'm:b'
```

以下 R6–R11 是修订时补充的复现。R8、R9、R11 使用上面的 Jest 配置；R6 用 Node 直接运行临时脚本；R7、R10 在临时 Git 仓库中运行仓库的 `scripts/version/cli.ts check`，每个情形一个仓库，`package.json` 只含 `version` 与一个 `devDependencies` 项。

**R6（PA-13）**：直接调用 `rollbackTarget`。

```ts
rollbackTarget([{ branch: 'default', activeWorld: false }, { branch: 'v0.1.15', activeWorld: false },
  { branch: 'v0.2.0', activeWorld: true }]);  // 结果：{ from: 'v0.2.0', to: 'v0.1.15' }
rollbackTarget([{ branch: 'v0.2.3', activeWorld: false }, { branch: 'v0.2.4', activeWorld: false },
  { branch: 'v0.2.5', activeWorld: true }]);  // 结果：{ from: 'v0.2.5', to: 'v0.2.4' }
```

**R7（PA-14）**：合并方向。

```bash
# 发布：master 0.1.11（含 src/a.ts）；dev 改为 0.2.3 并修改 src/a.ts
git switch master && git merge --no-ff --no-commit dev && node <仓库>/scripts/version/cli.ts check
# 结果：版本号跳变不符合规则：0.1.11 → 0.2.3，退出码 1
# 同一里程碑发布 master 0.1.5 ← dev 0.1.11：通过；合并后把工作区改为 0.1.12 再 check：仍通过
# 同步：任务分支 0.1.11 ← 0.2.2：版本号跳变不符合规则，退出码 1
```

**R8（PA-16）**：tick 倒退。

```ts
let t = 0;
const mod: ModuleDefinition = { id: 'w', tier: 'survival', priority: 0, setup: (ctx) => {
  const data = ctx.memory.partition('p', { version: 1, initialize: () => ({ n: 0 }), migrate: () => ({ n: 0 }) });
  return { act: () => { data.set(['n'], t); } }; } };
const h = kernelHarness({ modules: [mod], game: { time: () => t } });
for (const time of [100, 101, 102, 50, 51, 52]) { t = time; h.tick(); }
// 结果：健康状态全为 ok；act 6 次；持久值依次为 100、101、102、102、102、102；
// "Memory 不可用" 1 行，"Memory 提交失败" 3 行
```

**R9（PA-17）**：体积告警。

```ts
// tick 1：initialize 后写入 1.85 Mi 字符的分区并提交；tick 2–20：每 tick 改一个字段并提交
// 结果：20 次提交，warn 中"接近 2 Mi 字符上限"20 次
// tick 21：把分区改为超过 2 Mi 字符；tick 22–31：每 tick 改一个字段并提交
// 结果：11 次提交全部抛错，write 调用次数仍为 20
```

**R10（PA-18）**：构建产物变化的判定。

```bash
# 任务分支：git mv src/a.ts moved.ts；合并进 dev，版本号不变
git diff --name-only HEAD               # moved.ts
git diff --name-only --no-renames HEAD  # moved.ts src/a.ts
node <仓库>/scripts/version/cli.ts check  # 合并未改变构建产物，版本号保持 0.1.11（通过）
# 任务分支只增加 overrides：同样输出"合并未改变构建产物"并通过
```

**R11（PA-19）**：settings 的导入方。

```ts
checkBoundaries({ root, srcRoot, files: {
  'contracts/log.ts': ..., 'settings.ts': ...,
  'app/ops/index.ts': "import { levels } from '@/settings';\n...",
  'app/boot/index.ts': "import { levels } from '@/settings';\n...",
  'kernel/console/index.ts': "import { levels } from '@/settings';\n...",
} });
// 结果：只有 kernel/console/index.ts 报 layer 违规
```

## 修订记录：核实外部评审

### 来源与方法

- **来源**：同日的另一份全项目审计 `docs/audit/2026-10-20-project-audit-1.md`。它来自分支 `claude/gracious-mccarthy-outyft`，基线为 `4a73596`（0.1.11，第 5 步只有设计、尚未实现），重点是部署与版本工具、平台源码与 kernel 的边角情形。该文件没有进入版本控制，也未登记到索引；内容并入本报告后已删除。
- **方法**：
  - 比较两个基线：`scripts/`、`test/boundary/`、`src/kernel/memory/`、`README.md`、`.gitignore` 在 `4a73596` 与 `077cbc1` 之间没有变化，涉及它们的条目在本基线上直接成立与否只取决于复现；`src/kernel/lifecycle/`、`src/app/assembly/`、测试宿主有变化，相关条目在本基线上重新定位行号并复现。
  - 逐条在本基线上复现（附录 B 的 R6–R11）或核对源码；平台事实下载 npm 发布包核对。
  - 外部评审中依赖 0.1.11 状态的陈述（cpu、stats、console、ops"未实现"，`kernel/context` 中的临时预算）不再成立，不采用。

### 逐条核实

| 外部编号 | 核实结论 | 本报告的处置 |
| --- | --- | --- |
| PA-01 回滚目标 | 成立（R6） | 新增 PA-13；影响一项改按本基线的临时 boot 表述 |
| PA-02 版本校验 | 成立（R7）；另复现"发布时误 bump 不被发现" | 新增 PA-14 |
| PA-03 签名比例 | 成立（backend `place-spawn`、架构 9.2、11.6、附录 C）；另发现保底 creep 同样不带签名（9.2 第 796 行） | 新增 PA-15，方案 A 相应补充 |
| PA-04 beginTick 抛错 | 成立（R8），lifecycle 行号随第 5 步更新 | 新增 PA-16 |
| PA-05 体积告警 | 成立（R9）；其方案 A 中"由 stats 写入统计页"已由第 5 步实现（`memory.total`），方案相应删去这一部分 | 新增 PA-17 |
| PA-06 构建变化漏判 | 成立（R10） | 新增 PA-18 |
| PA-07 settings 导入方 | 成立（R11）；app.ops 已在第 5 步交付 | 新增 PA-19 |
| PA-08 分支累积 | 成立（backend 第 227–228 行） | 新增 PA-20 |
| PA-09 README 过期 | 与本报告 PA-11 重复 | 并入 PA-11，补充 `--only` 用法 |
| PA-10 cpu 设计表格 | 与本报告 PA-10 第 4 条重复 | 不变 |
| PA-11 杂项 | `.gitignore` 与本报告 PA-12 重复（PA-12 列出的旧规则更多）；场景辅助模块摘要的路径错误成立；app.assembly 的设计位置成立 | 路径错误并入 PA-21；设计位置补入 PA-10 第 1 条 |
| PA-12 JSDoc 缺口 | 成立，assembly 与测试宿主的行号随第 5 步更新 | 并入 PA-21 |
| 观察：产物注释 | 成立；在 0.1.12 上重测为 35.4%（外部评审在 0.1.11 上为约 36%） | 新增"观察"一节 |
| 观察：errorMapper 堆栈 | 成立（driver `runtime-driver.js` 第 23、67 行） | 新增"观察"一节 |
| M1 交付进度 | 基于 0.1.11，大部分已过时；platformFakes 只有 Memory 与 segment 的说法成立 | 修订"M1 完成度"表的工程一行 |
| 已核对事项 | 部署 API、平台语义与版本历史经复核成立，并入"已核对事项"。一处引用不精确：backend `user.js` 第 211 行校验的是 `clone-branch` 的源分支名 `branch`，新分支名 `newName` 在 backend 3.3.0 中没有长度校验；部署工具的 `BRANCH_PATTERN` 限制为 30 个字符，比服务器更严，不构成问题。`npm audit` 与源码注释规则的全量核对没有复核 | 并入"已核对事项" |

### 对本报告的修订

- **基线与范围**：关键文件哈希表补充部署、版本、边界检查与测试宿主等文件；增加修订说明。
- **结论**：总结句与级别统计更新为 2 项 P2、6 项 P3、11 项 P4、2 项范围外；汇总表增加 PA-13 至 PA-21；补充各问题的触发时点。级别定义补充"错误操作"（P2）、"流程阻碍"（P3）与"罕见条件下出现"（P4），以覆盖新增问题，原有问题的级别不变。
- **架构合理性评估**：分层与依赖、持久化、工程三行补充问题与编号；新增"启动判定（第 6 步）"一行。
- **问题**：新增 PA-13 至 PA-21；补充 PA-10 第 1 条与 PA-11 的 README 一行。
- **观察**：新增一节。
- **已核对事项**：原"版本工具的规则与 README 的版本号规则一致"不成立（check 的问题见 PA-14、PA-18），改为只就 bump 规则作出结论；新增部署 API、平台语义与版本历史三项。
- **M1 完成度**：platformFakes 改为部分交付。
- **验证、待用户决定、附录 B**：增加修订时的检查、PA-13 至 PA-21 的建议，以及复现 R6–R11。
