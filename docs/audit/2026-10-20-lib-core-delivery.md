# lib 核心与第 5 步设计的工作区交付审计

## 基线与范围

- 日期：2026-10-20。
- 分支：`feat/lib-core`；HEAD：`e0c51385ec4ec18d62a02c5584baa2c8092fe3c0`（dev 0.1.10，合并 feat/segments-bootport），没有任务提交。
- 审计对象：工作区中尚未提交的全部改动，分为两部分：
  - **lib 代码交付**：`src/lib/hash/`、`src/lib/naming/`、`src/lib/geometry/`，对应的设计 `docs/design/lib/` 与测试 `test/lib/`（含引擎采样夹具 `test/lib/fixtures/engine-geometry.json`）；
  - **第 5 步的模块设计**（尚无代码）：`docs/design/kernel/cpu.md`、`docs/design/kernel/stats.md`、`docs/design/kernel/console.md`、`docs/design/app/ops.md`；
  - 设计索引 `docs/design/README.md` 的改动。
- 关键文件 SHA-256 前 12 位：

  | 文件 | 哈希 |
  | --- | --- |
  | `src/lib/hash/index.ts` | `ac567ee9a42a` |
  | `src/lib/naming/index.ts` | `ecb498cf88bf` |
  | `src/lib/geometry/index.ts` | `d49636fa3272` |
  | `test/lib/fixtures/engine-geometry.json` | `05e23e1226c5` |
  | `docs/design/lib/hash.md` | `01e2ce93c693` |
  | `docs/design/lib/naming.md` | `b8d9094491b5` |
  | `docs/design/lib/geometry.md` | `34ff7dc9ffb7` |
  | `docs/design/kernel/cpu.md` | `c11d7a2e329c` |
  | `docs/design/kernel/stats.md` | `d1cc74f4be0b` |
  | `docs/design/kernel/console.md` | `3d58228ecd47` |
  | `docs/design/app/ops.md` | `81e19dd4f17b` |

  下文行号对应这份快照；已合并文件（`src/app/assembly/index.ts`、`src/fallback.ts`、架构设计）的行号对应 HEAD。
- 依据：架构设计 4.3、4.5、5.2、5.3、5.5、5.7、5.8、6.7、9.2、11.3、11.9、12.1、12.2、13.3、13.4 与附录 A、B；[contracts](../design/contracts/README.md)；[内核设计](../design/kernel/README.md)。平台事实以场景镜像 `leviathan-scenarios:local` 中的 `@screeps/engine` 4.3.2、`@screeps/driver` 5.3.0 源码，以及 npm 发布的 `@screeps/driver` 5.2.7 包核实。
- 前置检查：[挂起问题列表](./suspended.md)当前为空。
- 本轮约束：只新增本报告并更新索引，不修改实现、测试、设计或三份最高章程，不提交、不合并。

## 结论

**lib 代码本身没有阻断问题，但发现一项平台事实错误，它会使 naming 在部分私服上无法生成名称；第 5 步的 cpu 设计在实现前需要修正两处准入缺陷。**

lib 部分：

- hash 的固定向量经独立 Python 实现核对一致；
- naming 的格式、规范形式与架构 9.2 一致；
- geometry 的方向与房间名换算与引擎采样一致。

确认 2 项 P2、2 项 P3、3 项 P4，另有 1 项范围外问题：

| 编号 | 级别 | 部分 | 问题 |
| --- | --- | --- | --- |
| LC-01 | P2 | lib、章程 | 私服**提供** `Game.shard`，名称为服务器主机名；架构 F7 与"私服为 `x`"的规定不成立，naming 遇到含 `-` 或超过 16 个字符的主机名时 `formatName` 抛错 |
| LC-02 | P2 | cpu 设计 | "上一 tick 落选者优先"改变了准入判定的次序，排在前面的实例与同层依赖方在其模块或依赖尚未判定时就被拒绝，且落选次数不归零，永久落选 |
| LC-03 | P3 | cpu 设计 | 预检以平滑耗用为预计值，未运行的进程不更新；按剩余预算自适应的长计算在预算收缩后永久落选 |
| LC-04 | P3 | console、ops 设计 | kernel 抛错或冷却期间 `ops` 只有桩对象；持续抛错时命令总在实例销毁后执行，运维命令在最需要时不可用 |
| LC-05 | P4 | lib | `worldRange` 跨房时不是实际步数的下界：出口格两侧是同一位置，每跨一条边界多计 1 |
| LC-06 | P4 | cpu 设计 | Memory 维护归入维护层，但不受维护层"每 N tick 一次"的条件约束，与架构 5.2 的层定义不一致 |
| LC-07 | P4 | 范围外 | 架构 13.4 的"保底循环接管 → `Game.notify`"在入口、保底与第 5 步设计中都没有承接方 |

分级：

- **P2**：会在已规划的使用方接入后导致功能失效的设计或事实错误；
- **P3**：可以延后、但应记录处置的潜在问题或运行成本问题；
- **P4**：文档缺口，或只在调用方违反约定时出现的边角问题。

lib 目前没有使用方，第 5 步设计尚未实现，所以以上问题都没有线上影响。LC-01 的触发路径在 M2 的 spawnQueue 接入后出现；LC-01 的标记字段问题在第 6 步 app.boot 初始化 Memory 后出现。

## 问题

### LC-01 · P2 · 私服提供 Game.shard，名称为主机名

**类别：章程事实错误（报告并建议修订）；对 naming 设计与装配的影响属于范围内修正。证据：源码核实、运行日志。**

- **平台事实**：
  - `@screeps/driver` 在玩家沙箱中定义 `Game.shard`，`name` 为 `os.hostname()`：
    - 场景镜像的 driver 5.3.0：`lib/index.js` 第 36–38 行；
    - npm 发布的 driver 5.2.7（即架构附录 A 引用的版本）：同一位置，内容相同。
  - engine 4.3.2 的 `src/game/` 不定义它。架构 [附录 A](../design/architecture.md) 第 1642 行 F7 写"私有服务器不提供 `InterShardMemory`、`Game.shard`"，依据是 engine `src/game/`，没有考虑 driver 的注入。
  - 场景镜像的 engine、driver 与 common 源码中都没有 `InterShardMemory`，F7 关于 `InterShardMemory` 的部分成立。
  - 运行佐证：两次私服场景中，保底循环的名称为 `fb-2fd3fa1de4b9-3-0`、`fb-17978e1eaa48-3-0`。第二段由 [fallback.ts](../../src/fallback.ts#L227) 第 227 行的 `Game.shard?.name ?? 'x'` 生成，取值是 Docker 容器的默认主机名，即容器 ID，每次重建容器都会变化。
- **受影响的规定**：
  - 架构 6.7 第 495 行：`shard` 字段"私服为 `x`"；
  - 架构 9.2 第 790 行："shard 未知时（私服）写 `x`"；
  - 架构 11.3 第 1238 行：`here = Game.shard?.name ?? 'x'`，在私服上得到主机名；
  - [naming.md](../design/lib/naming.md) 第 22 行："私服与不跨 shard 时为 `x`"。
- **传播与影响**：
  - **naming**：[naming/index.ts](../../src/lib/naming/index.ts#L94) 第 94 行的 shard 正则为 `^[A-Za-z0-9]{1,16}$`，因为 `-` 是字段分隔符，所以不能放宽。私服主机名常含 `-`（如 `screeps-server`）、`.` 或超过 16 个字符。来源 shard 取 `Game.shard.name` 时，`formatName` 抛 `TypeError`（第 143–146 行）。M2 的 spawnQueue 接入后，这类私服上正常循环无法为任何 creep 命名。
  - **项目标记**：[app/assembly/index.ts](../../src/app/assembly/index.ts#L123) 第 123 行的 `GamePort.shard()` 在私服返回主机名，经 [bootPort/index.ts](../../src/kernel/bootPort/index.ts#L93) 第 93 行写入新建标记的 `shard`。默认容器主机名随重建变化，同一份 Memory 在重建后看到的 `here` 与标记、名称中记录的 shard 都不同。
  - **启动判定**：11.5 以名称中的来源与目标 shard 判定跨 shard。主机名变化后，本系统在私服上的 creep 会显得来自"另一个 shard"，可能误入 SHARD_SEED 或 STRANDED 的分支；具体后果要等第 6 步 app.boot 的设计才能确定，这里属于待验证推断。
  - **保底名称**：主机名含 `-` 时，保底名称的段数变多。它不经 naming 解析，不影响功能，只是名称变长。
- **复核方式**：在场景镜像中读取 driver 源码；`npm pack @screeps/driver@5.2.7` 后检查同一文件；场景日志中的保底名称。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 身份用的 shard 名定义为：运行环境提供 `InterShardMemory` 时取 `Game.shard.name`，否则为 `x`。私服不支持多 shard，这与"私服为 `x`"的设计意图一致。修改 `GamePort.shard()` 与保底名称的取值；修订架构 F7、11.3 的 `here` 表达式，并同步 naming 设计 | 需要用户针对架构设计给出修订指令；装配与保底各改一行，并补测试；官服行为不变 |
| B | 把主机名规范化（替换非法字符、截断）后使用 | 名称合法，但默认容器主机名随重建变化，跨重建的身份仍不稳定；不建议 |
| C | 只在 naming 设计中注明限制，由部署方保证私服主机名合法且固定 | 不改代码；依赖运维约定，场景测试的默认容器不满足 |

### LC-02 · P2 · 落选者优先打乱了准入判定次序

**类别：范围内修正（设计）。证据：设计文档核实（尚无实现）。**

- **来源**：[cpu.md](../design/kernel/cpu.md#32-准入流程) 第 52–62 行。
  - 候选顺序把上一 tick 落选的进程排在前面（第 56 行）；
  - 判定时，"`requires` 的模块本 tick 未被准入 → 不准入"（第 58 行）；
  - 第 46 行与第 72 行要求实例只有在所属模块被准入时才能准入；
  - 只有"被准入"才把连续落选次数归零（第 61 行）。
- **传播**：按流程逐个判定时，排在前面的落选实例先于其所属模块被判定，模块"本 tick 尚未被准入"，实例因此被拒绝。同层的依赖方先于依赖被判定时，结果也一样。
  - 这种拒绝不计入落选、也不归零，进程保留原有的连续落选次数，下一 tick 仍排在最前，再次在其模块或依赖之前被判定。
  - 结果是：一个经济层实例只要因预算落选过一次，在本 global 内就再也不会运行；它的平滑耗用也不再更新（见 LC-03）。
  - 跨层依赖不受影响：生存层总是先准入，三层按经济、维护、规划的顺序判定，`requires` 不允许指向更低的层。
- **影响**：
  - M2 的实例（采集、物流等经济层实例）在预算紧张时落选一次，就会永久停摆；
  - 第 71 行"落选进程下一 tick 优先"的目标恰好反过来，落选进程永远不会再运行；
  - 现有设计没有出口，只能靠软重置或 global reset 恢复。
- **复现**：没有实现，无法以测试复现。上述推导严格依据第 52–62 行的流程；如果"未被准入"的本意是"已判定且被拒绝"，需要在设计中写明，并说明尚未判定的依赖如何处理。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 判定一个候选前，先对其尚未判定的所属模块与同层 `requires` 依赖做判定，依赖不能准入时本候选不准入，并按"落选"计数（使其优先级反映真实原因） | 判定顺序仍为"落选者优先"；每个进程最多判定一次，成本仍为 O(进程数) |
| B | 落选者优先只在"本 tick 已无其他条件阻挡"的候选间排序：先按拓扑顺序确定可判定集合，再在集合内按落选次数排序 | 实现比 A 复杂；效果相同 |
| C | 实例不单独准入，随所属模块整体准入，只保留模块级的预检 | 改变 5.2 "实例准入"的粒度，与 M2 的 `admit` 实例过滤不匹配；不建议 |

### LC-03 · P3 · 自适应长计算在预算收缩后永久落选

**类别：范围内修正（设计）。证据：设计文档核实。**

- **来源**：[cpu.md](../design/kernel/cpu.md#32-准入流程)。
  - 第 59 行：以平滑耗用为预计值做预检；
  - 第 101 行：首个样本直接作为初值，本 tick 没有运行的进程不更新；
  - 第 75 行：长计算受 `shouldYield` 约束。
  - 架构 5.2 也要求长计算"每 tick 检查剩余预算"。
- **传播**：按剩余预算自适应的进程，会一直算到 `shouldYield()` 为真。它的样本约等于运行时剩下的份额，反映的是当时有多少预算，而不是它最少需要多少。
  - 例：bucket 为 10000 时 B 约为 25，进程样本约 20；bucket 回落到目标后 B 为 20、`poolEnd` 为 18；预计值 = 当前读数 + 生存层耗用 + 20，超过 18。
  - 进程从此落选，不运行就不更新平滑耗用，预计值停在 20，之后每个 tick 都放不下。
- **影响**：
  - 规划层与维护层的长计算（布局、扩张评估）在 bucket 回落后永久停止；
  - LC-02 修正后它们仍会受此影响；
  - 只有 global reset 才能恢复，因为 reset 后预热按 0 计。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 落选的 tick 对该进程的平滑耗用做一次衰减（例如乘以 `1 − CPU_EMA_ALPHA`），连续落选数 tick 后必然放得下，运行后再由实际样本校正 | 每个落选进程每 tick 一次乘法；昂贵进程会周期性地重试，重试时仍受 `shouldYield` 与紧急刹车约束 |
| B | 连续落选达到上限（例如 `STARVE_LIMIT`）且排在本层最前时，只要剩余份额大于 0 就准入一次 | 增加一个参数；行为更直观，但上限内的重试间隔固定 |
| C | 由进程声明"每片的耗用上限"，预检用声明值 | 新增 API，须经用户同意；目前没有使用方 |

### LC-04 · P3 · kernel 不可用时运维命令也不可用

**类别：范围内修正（设计）。证据：设计文档核实、平台源码核实。**

- **来源**：
  - [console.md](../design/kernel/console.md#4-安装) 第 121 行：kernel 实例销毁时，把它安装的命名空间替换为桩对象，调用任何命令都返回"kernel 未运行"；
  - [ops.md](../design/app/ops.md#4-宿主接口) 第 76 行：`ops` 由装配方随每个 kernel 重新创建；第 63 行的 `status()` 只读 kernel 的快照。
- **传播**：
  - 控制台表达式在 `module.exports.loop()` 之后求值（engine 4.3.2 `src/game/game.js` 第 517–548 行，场景镜像中核实）；
  - 入口在 kernel 抛错的同一个 loop 内销毁实例（[main.ts](../../src/main.ts) 的 `catch` 分支）。
  - 因此 kernel 每 tick 都抛错时，控制台命令执行时永远没有实例，`ops.status()` 总是桩结果；冷却期间同样如此。
- **影响**：
  - 正常循环崩溃或冷却时，运维无法从控制台得知冷却剩余时间、连续失败次数或最近一次错误，只能翻日志；
  - 这类信息只有入口掌握（`main.ts` 闭包中的计数与冷却截止 tick），kernel 观测不到；
  - 运维意图（暂停、恢复）在此期间无法下达。不过入口的失败来自 kernel 自身的缺陷，暂停业务模块本来也解决不了，所以这一点影响较小。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | `ops.status()` 在没有 kernel 实例时返回入口状态：冷却剩余 tick、连续失败次数、最近一次失败的说明。入口在装配时交给 app.ops 一个只读的入口状态读取函数，其他命令仍返回桩结果 | 入口与 app.ops 之间增加一个 app 内部的读取函数，不进入 contracts；入口需保存最近一次失败的说明 |
| B | 不改设计，在 ops 与 console 设计中写明 kernel 不可用时命令不可用，状态以日志为准 | 没有实现成本；故障时的可观测性依赖日志 |

### LC-05 · P4 · worldRange 跨房时不是实际步数的下界

**类别：范围内修正（文档与注释）。证据：引擎源码核实。**

- **来源**：
  - [geometry.md](../design/lib/geometry.md#3-方向与距离) 第 30 行与 [geometry/index.ts](../../src/lib/geometry/index.ts#L191) 第 191–193 行都写"跨房时……是实际步数的下界"；
  - 设计第 23 行写"`W0` 的 x = 49 与 `E0` 的 x = 0 相邻，跨房位置的差就是格数"。
- **平台事实**：creep 走上出口格后，同一 tick 被转到相邻房间的对边（engine `src/processor/intents/creeps/tick.js`：`x == 49` → `x = 0`、房间 X+1，其余三边同理）。出口格两侧实际是同一位置。
- **影响**：
  - 从 `W0N0 (48,25)` 走到 `E0N0 (1,25)` 只需 2 步，`worldRange` 为 3；每跨一条房间边界多计 1，最多多计跨越的边界数。
  - 测试第 66 行断言 `W0N0 (49,25)` 到 `E0N0 (0,25)` 为 1，实际是同一位置。断言本身符合"全局格坐标差"的定义，没有错。
  - 如果 M2 的移动或物流把它当作可采纳的启发值（A* 下界），会得到次优结果；目前没有使用方。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 只改文档与注释：`worldRange` 是全局格坐标的 Chebyshev 距离；跨房时每跨一条边界比实际步数多 1，减去跨越的边界数才是步数下界 | 无实现成本 |
| B（新增 API） | 另提供考虑出口合并的步数下界函数 | 目前没有使用方，不建议提前设计 |

### LC-06 · P4 · Memory 维护的层归属与架构 5.2 不一致

**类别：范围内修正（文档）。证据：设计文档核实。**

- **来源**：[cpu.md](../design/kernel/cpu.md#33-kernel-自身的任务) 第 82 行，Memory 维护属于维护层，但"不受 `MAINTENANCE_PERIOD` 约束"。
  - 架构 5.2 第 291 行把维护层定义为"每 N tick 一次，按 `hash(id) % N` 错峰"；
  - 第 296 行强调"维护层的执行周期与错峰不因取消 bucket 门槛而取消"。
- **影响**：同一层有两套准入条件。设计给出了理由（维护按记录数分批），但没有说明与 5.2 的关系；读者按架构理解维护层时会得出不同结论。不影响正确性：creep 回收比较的是相邻两个已观测 tick 的名称快照，与维护多久运行一次无关（[memory](../design/kernel/memory.md)）。

**选项：**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 把 Memory 维护列为 kernel 的收尾类任务，与提交一样不参与层准入，按每 tick 的记录上限运行，并计入收尾预留 | 收尾预留的消耗增加一项，单次成本以记录上限约束 |
| B | 保留在维护层，`MAINTENANCE_PERIOD` 取 1；或在设计中写明这是 kernel 任务的例外，并请用户确认是否在架构 5.2 中注明 | 需要用户决定是否修订章程 |

### LC-07 · P4 · 范围外：保底接管的通知没有承接方

**类别：范围外问题。证据：文档与源码检索。**

- **位置**：架构 13.4 第 1526 行要求保底循环接管时调用 `Game.notify`。
- **现状**：
  - [stats.md](../design/kernel/stats.md#2-指标) 第 34 行明确把它划给入口；
  - 入口（[内核设计](../design/kernel/README.md#6-入口正常循环与保底循环)第 6 节、`src/main.ts`）与[保底设计](../design/fallback.md)都没有对应规定，`src/` 中也没有 `Game.notify` 调用。
- **影响**：保底接管只体现在日志中，不会主动通知。M1 的验收要求"混沌测试中保底循环能接管"，没有要求通知；通知缺失影响的是 13.4 的线上监控。
- **建议**：在第 5 步或第 6 步，由入口设计承接此项，并规定通知的频率限制，避免持续接管时反复通知。

## 已核对事项

以下各项已逐一核实，没有发现问题：

- **hash**：
  - 固定向量 `''`、`'a'`、`'leviathan'`、`'lv-shard0-hv-x-18nrw9.2'`、`'中文'` 与独立 Python 实现（逐 UTF-16 码元的 FNV-1a 32 位加 fmix32）结果一致；
  - `>>> 0` 保证非负；
  - 没有模块级状态，不分配对象。
- **naming**：
  - 6 段格式、规范 base36 往返、校验位取"校验位之前的全部文本 + salt"，与架构 9.2 一致；
  - 示例 `75012345` 的 base36 为 `18nrw9`，完整名称 25 个字符；
  - 字段上限下的最长名称约 73 个字符，在平台名称长度限制内；
  - 保底名称段数不同，总是不能通过校验；
  - 只依赖 lib.hash，符合 lib 层的依赖规则。
- **geometry**：
  - `direction()` 的分支与引擎 `getDirection` 等价，169 组位移与夹具一致；
  - 房间名正则对大小写与前导零的限制已在设计中注明；
  - 世界打包的两个分量各占 17 位，打包值小于 2^34，`worldX` 与 `worldY` 的取整在负坐标下正确。
- **cpu**：
  - B 与透支额的公式、收尾预留、各层条件与架构 5.2、5.3 及附录 B 一致；
  - 生存层以 `hardEnd` 为上限，体现"总是准入，但不越过收尾预留"。
- **console**：
  - "loop 之后在同一全局作用域求值控制台表达式"已在场景镜像的 engine 源码中核实；
  - 模块 id 为小写驼峰（contracts 第 2 节），可以直接作为全局名；
  - 与已有全局冲突时拒绝安装。
- **ops**：
  - 启停标志只记录覆盖，生存层不可暂停，暂停仍执行 setup；
  - 与内核设计第 3.3 节"不重新 setup"的约束一致；
  - 契约变更（`ModuleContext.console`、`ModuleManifest.startPaused`、保留 id `kernel` 与 `ops`）属于用户事先同意的第 5 步契约范围。
- **stats**：
  - 只写不读；
  - 通过 segments 的 `stats` store 写入第 50 页，bucket 低时推迟并只保留最新窗口；
  - 超限时截短重试，符合 6.8 安全规则 4。
- **文档**：
  - 新增设计与索引中的相对链接、章节锚点全部可解析（脚本核对）；
  - 设计索引的条目与新增文件一一对应。
- **注释**：三个 lib 源文件都有文件摘要，具名函数都有 JSDoc，常量与正则都有说明；有效代码行数分别为 15、49、59。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check`（类型检查、单元与边界测试、构建） | 通过；28 个测试套件，350 项测试 |
| `git diff --check`（临时索引包含未跟踪文件） | 通过 |
| hash 固定向量 | 与独立 Python 实现一致 |
| 平台源码核实 | 场景镜像中 driver 5.3.0 `lib/index.js` 的 `Game.shard`，engine 4.3.2 `src/game/game.js` 的控制台求值次序与 `src/processor/intents/creeps/tick.js` 的出口转移；npm 发布的 driver 5.2.7 包中 `Game.shard` 的定义 |
| `npm run test:scenarios` | 未运行：本次交付不改变构建产物中的运行路径（lib 没有使用方），LC-01 的佐证引用的是上一轮任务中两次场景运行的日志 |

LC-02、LC-03、LC-04 针对的是尚未实现的设计，依据是设计文档的推导，没有测试复现。LC-01 中关于启动判定后果的部分属于待验证推断，要等第 6 步 app.boot 的设计才能确定。

## 待用户决定

| 编号 | 建议 |
| --- | --- |
| LC-01 | 方案 A：身份用的 shard 名在没有 `InterShardMemory` 时为 `x`；需要你给出修订架构 F7 与 11.3 的指令 |
| LC-02 | 方案 A：判定候选前先判定其所属模块与同层依赖 |
| LC-03 | 方案 A：落选时衰减平滑耗用 |
| LC-04 | 方案 A：kernel 不可用时 `ops.status()` 返回入口状态 |
| LC-05 | 方案 A：修正文档与注释 |
| LC-06 | 方案 A：Memory 维护列为收尾类任务 |
| LC-07 | 范围外，建议在第 5 或第 6 步由入口设计承接 |

## 整改与复核记录（2026-10-20）

用户决定：同意修订架构 F7 与 11.3；LC-01 至 LC-06 按建议（方案 A）整改；LC-07 纳入第 5 步。整改在 `feat/lib-core` 的工作区进行，未提交。

### 整改内容

| 编号 | 整改 | 与建议的差异 |
| --- | --- | --- |
| LC-01 | 架构附录 A 的 F7 改为"私服不提供 `InterShardMemory`、`Game.cpu.shardLimits`；`Game.shard` 由 driver 注入，名称为主机名，不代表多 shard 环境"，依据补充 driver `lib/index.js`；11.3 改为 `here = hasISM ? Game.shard.name : 'x'`。装配的 `GamePort.shard()` 复用 `kernel.intershard` 的 `available()`；`src/fallback.ts` 的保底名称改用同一规则，以 `typeof InterShardMemory` 检测。同步内核设计第 1 节、`GamePort` 注释、bootPort 设计第 4 节、naming 设计第 2 节与保底设计。架构 6.7、9.2 的"私服为 `x`"指身份用的 shard 名，在新定义下成立，未改动 | 增加一处边界检查的调整：`test/boundary/check.ts` 的 storage 规则原先只要出现 `InterShardMemory` 标识符就报违规，保底循环不能导入任何模块，无法复用 kernel.intershard。现只放行 `typeof InterShardMemory`：它只做特性检测，不读写内容（5.7）。`typeof Memory` 会触发引擎解析，不在例外之列 |
| LC-02 | cpu 设计第 3.2 节改为 judge 流程：先递归判定所属模块与同层依赖，每个进程每 tick 只判定一次 | 增加"空闲"这一判定结果：实施时发现，维护层的模块、实例与同层模块按各自的进程键错峰，相位一般不同；若依赖必须在同一 tick 运行，实例只会在相位重合时运行。改为只有依赖"落选"时才阻挡依赖方，"空闲"（层条件不满足）不阻挡 |
| LC-03 | 因预算落选时，预计值乘以 `1 − CPU_EMA_ALPHA`；因依赖落选时不衰减 | 无 |
| LC-04 | ops 设计第 4 节：kernel 不可用时 `ops.status()` 返回入口状态（冷却剩余、连续失败、degraded 与暂停计数、最近一次失败）；console 设计第 4 节增加宿主侧的离线命令 `offline(name, fn)`；内核设计第 6 节增加"入口状态"，在第 5 步交付 | 实现方式是"离线命令"：桩对象调用离线处理函数，只能读取跨实例存在的入口状态。报告未指定实现方式 |
| LC-05 | `worldRange` 的注释与 geometry 设计改为"全局格坐标的 Chebyshev 距离；跨房时每跨一条边界多计 1，不是步数下界"，并给出例子；测试注释同步 | 无 |
| LC-06 | Memory 维护改为收尾任务，不参与分层准入，按每 tick 记录上限运行并计入收尾预留（cpu 设计第 3.3 节、内核设计第 2 节） | 无 |
| LC-07 | 内核设计第 6 节增加"接管通知"：保底接管开始时经 `Game.notify` 发出纯文本通知，`FALLBACK_NOTIFY_GAP`（1000 tick）内不重复，在第 5 步交付；stats 设计改为指向该条 | 无 |

### 回归测试与反向验证

| 编号 | 回归测试 | 反向验证 |
| --- | --- | --- |
| LC-01 | `test/app/assembly.test.ts` 新增 1 项：私服（无 `InterShardMemory`、主机名 `screeps-server-1`）时 `GamePort.shard()` 为 `x`，官服为 `Game.shard.name`。`test/fallback/fallback.test.ts` 新增 2 项：私服的保底名称为 `fb-x-…`；官服的检测不读取 `InterShardMemory` 的任何属性（测试世界新增 `InterShardMemory` 守卫对象，读取属性即记录）。`test/boundary/boundary.test.ts` 新增 1 项：`typeof InterShardMemory` 允许，读写与 `typeof Memory` 仍报违规 | 把装配与保底的取值都还原为 `Game.shard?.name ?? 'x'` 后，装配与保底的 LC-01 测试各 1 项失败；恢复后 `src/app/assembly/index.ts` 为 `7b741d88c4b7`、`src/fallback.ts` 为 `62350bedf0be`，与修复后一致，37 项通过 |
| LC-02、LC-03、LC-04、LC-06、LC-07 | 设计修订，尚无实现；各设计文档的"验证"一节已列出第 5 步实现时须覆盖的测试 | 不适用 |
| LC-05 | 纯文档与注释修改 | 不适用 |

### 复核验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过；28 个测试套件，354 项测试（新增 4 项），构建成功 |
| `git diff --check`（临时索引包含未跟踪文件） | 通过 |
| 改动文档的链接与章节锚点 | 全部可解析（脚本核对设计目录中所有改动文档） |
| `npm run test:scenarios` | 3 个场景全部通过。fallback-takeover 中保底 creep 的名称为 `fb-x-3-0`，整改前为 `fb-<容器 ID>-3-0`，在真实私服引擎中确认了 LC-01 的整改 |

整改后的文件哈希（前 12 位）：

| 文件 | 哈希 |
| --- | --- |
| `src/fallback.ts` | `62350bedf0be` |
| `src/app/assembly/index.ts` | `7b741d88c4b7` |
| `src/kernel/context/index.ts` | `efa561b1782a` |
| `src/lib/geometry/index.ts` | `e59f2275781f` |
| `test/boundary/check.ts` | `a2b1ff234c01` |
| `docs/design/architecture.md` | `afde94c4c676` |
| `docs/design/kernel/cpu.md` | `93c52f2bbe46` |
| `docs/design/kernel/console.md` | `c8f680fd8ae3` |
| `docs/design/app/ops.md` | `3f473ee73d23` |
| `docs/design/kernel/README.md` | `1061dee1bfbd` |

七项均已关闭（LC-02、LC-03、LC-04、LC-06、LC-07 以设计修订关闭，实现在第 5 步），没有需要挂起的问题。

### 提交去向

- lib 三个模块与 LC-01、LC-05 的整改：`feat/lib-core` 的提交 `f071d53`，以合并提交 `b9f013f` 合并入 dev，版本号 0.1.11。
- 第 5 步的设计与 LC-02、LC-03、LC-04、LC-06、LC-07 的设计修订，以及本报告：从合并后的 dev 拉出的第 5 步任务分支 `feat/kernel-observability`。本报告链接了第 5 步的设计文档，所以随这些文档一起提交，避免 dev 上出现失效链接。

### 第 5 步实现时的回归测试与反向验证

LC-02、LC-03、LC-04、LC-06、LC-07 以设计修订关闭；第 5 步在 `feat/kernel-observability` 上实现时补充了回归测试。下表的反向验证是在工作区临时撤掉对应修正、运行测试、再恢复（恢复后文件哈希与撤掉前一致）。

| 编号 | 回归测试 | 撤掉修正后 |
| --- | --- | --- |
| LC-02 | `test/kernel/cpu/cpu.test.ts`：落选的实例排在所属模块之前时先判定模块并重新准入；同层依赖先判定；维护层依赖空闲不阻挡 | 把判定改回"所属模块与依赖本 tick 未被准入即拒绝"：2 项失败 |
| LC-03 | 同文件：自适应长计算在预算收缩后经衰减重新准入；因依赖落选时不衰减 | 去掉落选时的衰减：2 项失败 |
| LC-04 | `test/kernel/console/console.test.ts` 与 `test/app/ops.test.ts`：kernel 销毁后离线命令可用，`ops.status()` 返回入口状态；`test/main.test.ts`：入口状态的内容 | 桩对象忽略离线处理函数：2 项失败 |
| LC-06 | `test/kernel/lifecycle/ops.test.ts`：非生存层预算用尽时 Memory 维护仍每 tick 运行并回收 creep 记录 | 不适用：实现保持原有的"每 tick 调用"，测试固定该行为 |
| LC-07 | `test/main.test.ts`：接管开始时通知一次并写明原因，持续接管与间隔内的再次接管不重复，通知失败只报告 | 去掉接管通知：2 项失败 |
