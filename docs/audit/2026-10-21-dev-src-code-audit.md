# dev src 业务代码审计（cb51f01，0.1.18）

## 基线与范围

- 日期：2026-10-21。
- 基线：`dev` 的 `cb51f01`（0.1.18）。文中行号对应这一提交。
- 范围：只看 `src/` 下的代码本身：正确性、跨 tick 与重置下的一致性、失败路径、运行开销、平台事实，以及与设计和契约的一致性。不评价验证进度、流程与里程碑；测试与配置的问题列入附录，不计入问题清单。
- 方法：
  - 8 个审计 agent 按子系统通读源码：入口与保底、kernel 核心、Memory、segments/bootPort/stats、boot、诊断与运维、lib 与 contracts，另有一个跨模块的运行时与开销视角。共报告 38 条。
  - 每个子系统由一位独立的核实者逐条尝试推翻：重新核对行号，沿真实调用方追踪防护，用本机的公开引擎源码（`@screeps/engine` 4.3.2、`@screeps/driver` 5.3.0、`@screeps/backend` 3.3.0）核实平台事实，能复现的在临时副本中写一次性测试复现（用 `node:vm` 的 timeout 模拟 CPU 硬终止）。结果：35 条成立、2 条部分成立、1 条推翻（属于测试范围）。
  - 合并重复项后得到本报告的 27 项，另有 4 项测试与配置问题列入附录。
  - 完整性审查（找遗漏与交界问题）在本报告写成时仍在运行，结果见末尾"待补"一节。
- 本轮约束：不修改实现、测试与设计。

## 结论

**最重要的是一类系统性缺口：代码的失败模型把"CPU 硬终止"等同于 global reset，而公开 driver 在超时后保留 VM 与 heap，下一 tick 继续使用同一个 kernel 实例。** 加载、setup、软重置与初始化都有"先改状态、后完成"的窗口，被终止在窗口内时，实例停在不一致的状态，健康仍报 ok，保底不接管，没有日志，直到 global reset。其中 Memory 首次加载被终止（S-01）会使本 global 内所有模块静默停摆；若 Memory 中只有外来根键，还会在没有备份的情况下删掉它们。

其余问题集中在 boot 的几个"冻结证据"缺口、被拒模块的不可见、保底在多房间与同 tick 孵化时的分配、日志转义的开关耦合，以及加载与查找路径上可以省掉的开销。M1 的模块清单为空，多数问题要到 M2 接入模块后才会影响运营；S-01 与 S-07 在当前的 M1 代码上就能触发。

| 编号 | 级别 | 类别 | 问题 | 来源编号 |
| --- | --- | --- | --- | --- |
| S-01 | P1 | 范围内修正 | Memory 首次加载被硬终止后实例永久为 empty：不重试、健康 ok、保底不接管；只有外来根键时会被初始化覆盖 | KC2、M1、CR1 |
| S-02 | P2 | 范围内修正 | 模块 setup 被硬终止后，其余模块在本 global 内静默不运行 | KC1 |
| S-03 | P3 | 范围内修正 | 根表与单元索引分两步更新，中断后每次提交都抛错，持久化停止 | M2、CR2 |
| S-04 | P3 | 范围内修正 | 登记软重置的 tick 被硬终止后，旧实例下一 tick 不暂停、不重判，覆盖重生证据 | PA1、B6 |
| S-05 | P4 | 范围内修正 | 开局初始化的 tick 被硬终止后，下一 tick 判为 11.4 d NORMAL | CR6 |
| S-06 | P3 | 新增 API 或功能 | 越过 tickLimit 的钩子不留故障证据，每 tick 重新准入，终止可无限重复 | KC3 |
| S-07 | P3 | 范围内修正（须修订章程） | 同一 global 中重生而廉价不变量不变时，不触发完整判定 | B1 |
| S-08 | P3 | 范围内修正 | 11.4 c 的清空被拦下后，下一次完整判定解除冻结，之后可判为 NORMAL | B2 |
| S-09 | P3 | 范围内修正（设计取舍） | 非 FRESH_START 的 `boot.force` 永久生效，确认后未取消即关闭自动判定 | B3 |
| S-10 | P4 | 范围内修正 | 运行中途重生经软重置时，模式变化通知发两次 | B5 |
| S-11 | P4 | 范围内修正 | 从 control 分区读回的 force 不校验，非法值使 sys 被隔离 | B7 |
| S-12 | P3 | 范围内修正 | 被清单拒绝的模块在 ops.status 与统计页中都看不到 | KC4、D2 |
| S-13 | P4 | 范围内修正 | 空 id 的生存层模块被拒绝后不计入健康 | KC5 |
| S-14 | P4 | 范围内修正 | 启停标志中的非法值被当作 run，静默覆盖 startPaused | KC6 |
| S-15 | P4 | 范围内修正（须同步设计） | `ops.unset` 不能清除已移除模块或生存层模块的启停记录 | D3 |
| S-16 | P4 | 新增 API 或功能 | `ops.log` 的作用域参数不能调整 boot 与 kernel 自身的作用域 | D5 |
| S-17 | P3 | 范围内修正 | `CpuBudget` 契约写"本进程剩余"，实现是同层共用份额，`shouldYield` 不扣其他已准入进程的预计值 | LC1 |
| S-18 | P3 | 范围内修正 | 保底的应急孵化看不到正常循环同 tick 的 spawnCreep，会覆盖它的孵化意图 | E1 |
| S-19 | P3 | 范围内修正 | 保底的寻路名额与预留按遍历顺序分配，后面的房间与紧挨目标的 creep 被饿死 | E2 |
| S-20 | P4 | 简化 | 保底对 fatigue > 0 的 creep 照常寻路 | E3 |
| S-21 | P4 | 范围内修正（须修订设计） | 保底按部件推断角色，规划体型的矿工会离开 source | E4 |
| S-22 | P3 | 范围内修正 | 存在 logUnsafe 而关闭上色时，日志正文不经转义按 HTML 渲染 | D1 |
| S-23 | P4 | 范围内修正（待验证） | 控制台命令结果同样不经平台编码，多行结果可能被折叠 | D4 |
| S-24 | P3 | 简化 | 加载时对整个根执行 validateJson，成本数倍于 JSON.parse；相关注释夸大了冷却的效果 | M3、CR3 |
| S-25 | P4 | 简化 | 实体切片查找每次都 JSON.stringify 三元组键 | M5、CR5 |
| S-26 | P4 | 范围内修正 | geometry 文件摘要称打包"不分配对象"，与 packWorld 不符 | LC2 |
| S-27 | P4 | 范围内修正 | 备份按 UTF-16 码元切页，可能把代理对拆到两页 | PA2 |

分级：

- **P1**：会使主循环失效或造成不可逆的数据或资产损失；
- **P2**：违反设计或契约，在已规划的使用方下产生错误结果；
- **P3**：应记录处置的潜在问题；
- **P4**：边角问题、注释误导或小额开销。

## 平台事实：CPU 硬终止后同一 global 继续运行

S-01 至 S-06 都依赖这一点，单独说明：

- driver 5.3.0 `lib/runtime/make.js` 第 279–293 行：运行出错时，只有 `didHaltByUserRequest`（`Game.cpu.halt()`）、`Isolate is disposed`、`Isolate has exhausted v8 heap space` 与内存分配失败才清除 VM；CPU 超时（`runtime-driver.js` 第 101–106 行转为 "Script execution timed out: CPU time limit reached"）只抛出错误，VM 与 heap 保留，下一 tick 继续使用。
- 被终止的 tick 不保存 Memory 与 segment（`make.js` 中 `runResult` 不存在）。V8 的终止不执行 catch 与 finally，只在 JS 函数入口与循环回边处生效。
- 代码侧：[内核设计](../design/kernel/README.md#6-入口正常循环与保底循环)第 6 节"CPU 硬终止无法被 catch 接管，计数只统计可捕获的异常"，混沌测试与平台替身只模拟 `halt`（附录 X-02）。没有任何"上一 tick 未正常结束"的检测。
- 官服实现未开源，"超时后保留 global"在官服上是推断。

## 问题

### S-01 · P1 · Memory 首次加载被硬终止后实例永久为 empty

**证据：源码确认、测试复现（node:vm timeout）。来源：KC2、M1、CR1。**

- **来源**：[runtime.ts](../../src/kernel/memory/runtime.ts#L314) 第 314–326 行：第 315 行在读取与解析之前就置 `loaded = true`，`failure` 只在第 325 行的 catch 中锁存；`load`（第 182–216 行）到第 185 行（缺命名空间）或第 210–211 行才设置 `root` 与 `data`，此前第 202 行已逐个登记单元。
- **传播**：终止落在读取、`JSON.parse`、`summarize`、`validateJson` 或单元登记之间时，实例停在 `loaded = true`、`failure` 未定义、`data` 未定义、`root` 为初值 `{}`。之后每个 tick 第 314 行跳过加载，第 333 行返回 `empty`，不再调用 `read`；`ready()` 与 `failed()`（[index.ts](../../src/kernel/memory/index.ts#L135) 第 135、140 行）都为 false，这与第 98 行注释"加载失败不允许……误当空存储"矛盾。
- **落点**：
  - lifecycle（[index.ts](../../src/kernel/lifecycle/index.ts#L444) 第 444–472 行）不 setup、不运行业务阶段、不维护、不提交；`health`（第 364–371 行）只看 `memoryStale`、`failed()` 与被拒的生存层，返回 ok；入口（[main.ts](../../src/main.ts#L243) 第 243–244 行）清零 degraded，保底不接管；没有日志。持续到 global reset。
  - boot：有本项目命名空间时判为 UNLOADABLE 或 CORRUPT，动作为 none（非开局世界为 AMBIGUOUS；开局世界且时钟可用时判为 11.4 b 并清空，很少）。
  - 根中只有外来键时：概要在终止前已算出为 FOREIGN 且可初始化，boot 经 `port.initialize()` 在 `{}` 上建立命名空间（[boot/index.ts](../../src/app/boot/index.ts#L254) 第 254 行 → [bootPort](../../src/kernel/bootPort/index.ts#L137) 第 137 行），提交后外来根键被整体删除，事先没有备份，违反 11.4 b′ 的"外来键只读保留"。
- **复现**：用 `node:vm` 的 timeout 50 ms 在 `RawMemory.get` 与 `validateJson` 中终止 `kernel.tick`。之后 5 个 tick 健康都为 ok，生存层 setup 0 次，`ops.status().memory` 为 `empty`，`read` 只调用 1 次，没有日志；FOREIGN 情形下持久根只剩 `['leviathan']`。
- **触发条件**：global reset 后的首个 tick 同时承担代码编译与整份 Memory 解析，是 CPU 最高的 tick。bucket 低（`tickLimit` 接近 `limit`）时部署、服务器重启或 VM 回收，Memory 越大越容易落在这个窗口。
- **建议**：开始加载前先锁存一个"加载未完成"的 `failure`，成功后再清除；或在加载开始前把 `summary` 与 `root` 置为一致的失败态。boot 不以加载前的概要授权 `initialize`。回归测试用 `node:vm` timeout 在加载各步终止，反向验证为撤掉修复后健康仍为 ok。

### S-02 · P2 · 模块 setup 被硬终止后，其余模块在本 global 内静默不运行

**证据：源码确认、测试复现。来源：KC1（CR2 附带）。**

- **来源**：[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L254) 第 254 行在 setup 循环之前就置 `modulesSetUp = true`；第 446 行只看这个标志决定是否 setup。
- **传播**：终止落在某个模块的 setup 中时，它和排在后面的模块 `state` 仍为 `ready`、`hooks` 为 `undefined`。`canRun`（第 271–272 行）不检查 hooks；`runPhases` 第 323 行 `runtime.hooks?.[name]` 为 undefined 时直接跳过，不计量、不告警。
- **影响**：这些模块本 global 内不运行，`ops.status` 显示 running（[ops.ts](../../src/kernel/lifecycle/ops.ts#L230) 第 230–236 行），健康为 ok（第 368–369 行只看 state、broken、runnable），没有日志。被终止的模块是生存层时同样静默停摆。setup 发生在 Memory 首次就绪的 tick，常与首次加载同在成本最高的首个 tick。
- **复现**：模拟终止后 5 个 tick，后两个模块的 setup 与 act 都没有调用，健康全为 ok，status 为 failed/running/running。
- **建议**：setup 循环结束后再置标志，或逐个模块记录"已 setup"，未 setup 的模块下一 tick 补做；`canRun` 对 `hooks` 为 undefined 的 ready 模块按初始化失败处理并计入健康。

### S-03 · P3 · 根表与单元索引分两步更新，中断后提交永久失败

**证据：源码确认、测试复现。来源：M2、CR2（核实者修正了可中断窗口）。**

- **不变量**：[commit.ts](../../src/kernel/memory/commit.ts#L127) 第 127–129 行依赖"根表中的每个包络都在 `byRecord` 中有单元"，否则读 `.encoded` 抛 TypeError。
- **真实窗口**（V8 只在函数入口与循环回边处终止）：
  - [partitions.ts](../../src/kernel/memory/partitions.ts#L50) 第 50→51 行：新建分区先挂根表、再 `register`。setup 不会重跑，不自愈；
  - [entities.ts](../../src/kernel/memory/entities.ts#L146) 第 146–149 行：回收有多个 owner 的实体记录时逐个撤销单元，到第 157–158 行才删根记录；
  - entities.ts 第 85→89 行：新建切片先挂根表再登记，下一次 `of()` 会自愈。
  - 核实者确认 `runtime.ts` 第 260→261 行（两次 `Map.set`）与 `clear` 第 371–374 行之间没有中断点，不构成窗口。
- **影响**：之后每次提交都在 commit.ts 第 129 行抛 TypeError，本 global 内持久化停止；lifecycle 只在连续失败开始时记一条日志（第 464–471 行），健康仍为 ok。窗口只有几条语句，命中概率很低，但没有自愈路径。
- **复现**：setup 中申请两个分区，在第二个分区的 `register` 入口终止：之后 5 个 tick 健康 ok、持久文本不变，日志只有一条 "Cannot read properties of undefined (reading 'encoded')"。
- **建议**：先完成会抛错或会调用函数的准备，再以不含函数调用的连续赋值同时更新根表与索引；或让 commit 遇到无单元的包络时按结构变化补登记。与 S-01 一并加入"上一 tick 未完成"的检测，可以统一兜底。

### S-04 · P3 · 登记软重置的 tick 被硬终止后，旧实例覆盖重生证据

**证据：源码确认、测试复现（真实 app.boot）。来源：PA1、B6。**

- **来源**：[bootPort/index.ts](../../src/kernel/bootPort/index.ts#L162) 第 162 行 `softReset` 置 `reset` 与 `pausedNow`；第 174 行每 tick 的 `run()` 先清零 `pausedNow`。入口只在 `tick()` 正常返回后检查 `resetRequested()` 并销毁实例（[main.ts](../../src/main.ts#L249) 第 249–252 行），tick 之前不检查。
- **传播**：boot 的软重置分支（[boot/index.ts](../../src/app/boot/index.ts#L268) 第 268–271 行）不设 `rejudge`，对比第 263、274 行的备份分支都会设置；第 391 行已把 counts 更新为本 tick 的值。软重置登记之后、入口销毁之前的任一点被终止（boot 剩余部分、提交、stats、segments），下一 tick 同一实例：不暂停，不做完整判定，`maintain` 把 `lastRun` 写为放置之后的值，业务阶段照常运行。
- **影响**：新实例随后按 11.4 d 判为 NORMAL，不备份、不清空，认领上一局的 Memory，违反 11.4 附加规则 3。复现：epoch 保持 0，模式为 NORMAL。
- **建议**：入口在 `tick()` 之前检查 `kernel.resetRequested()`，为真时按软重置路径重建；boot 的软重置分支同时登记 `rejudge`，与备份分支一致。

### S-05 · P4 · 开局初始化的 tick 被硬终止后，下一 tick 判为 NORMAL

**证据：源码确认、测试复现。来源：CR6。**

- **来源**：[boot/index.ts](../../src/app/boot/index.ts#L254) 第 254 行在 heap 中初始化，占位标记的 `lastRun` 为当前 tick（[bootPort](../../src/kernel/bootPort/index.ts#L92) 第 92–97 行），提交在 tick 末尾。
- **传播**：被终止的 tick 不提交，平台上仍为 EMPTY，但 heap 中已有标记。下一 tick `ready` 由 false 变为 true，触发完整判定；[assess.ts](../../src/app/boot/assess.ts#L72) 第 72 行优先采用 heap 中的标记，判为 OURS；时钟可用且 `lastRun` 不早于放置，第 183–187 行判为 11.4 d NORMAL 并持久化。清空路径终止在 `clearMemory` 与 `clearInterShard`（第 276→277 行）之间时，还会漏掉 InterShardMemory 的清空。
- **影响**：违反 11.4 附加规则 3"判定相同、过程幂等"。开局 Memory 很小，概率低。
- **建议**：与 S-01、S-04 一并处理"上一 tick 未完成"：检测到时丢弃实例、从已提交文本重建。

### S-06 · P3 · 越过 tickLimit 的钩子不留故障证据

**类别：新增 API 或功能，须修订内核设计并经你同意。证据：源码确认（不可在 Jest 中构造不可捕获的终止）。来源：KC3。**

- **来源**：紧急刹车只在钩子之间读数比较（[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L301) 第 301–354 行）；`settle` 是唯一的采样点（[cpu/index.ts](../../src/kernel/cpu/index.ts#L318) 第 318–336 行），被终止的 tick 执行不到；`admit`（第 283–301 行）每 tick 重置 verdict 与 spent；未采样的进程按 0 计（第 251 行）。
- **影响**：非生存层钩子单次越过 tickLimit 被终止后，失败计数、平滑耗用、落选次数都不变，下一 tick 照常准入；确定性的超限每 tick 重复，耗尽 bucket，该阶段之后的生存层钩子与 Memory 提交每 tick 都执行不到，健康与保底都不起作用。现状符合设计（内核设计第 6 节）。
- **建议**：在 heap 中记录"当前进程键"，下一 tick 开始时若发现上一 tick 未正常结束，把该进程计为一次失败并跳过一个周期；须先修订设计。

### S-07 · P3 · 同一 global 中重生而廉价不变量不变时，不触发完整判定

**类别：范围内修正，须修订架构 11.1（章程）。证据：源码确认、测试复现、平台源码。来源：B1（核实者 P2，本报告调为 P3，理由见下）。**

- **来源**：[boot/index.ts](../../src/app/boot/index.ts#L82) 第 82、90–91 行的 `jumped` 与 `mutated` 只比较 spawn 数、建筑数与 creep 数；第 390 行据此决定是否完整判定。实现与架构 11.1 的廉价不变量逐字一致。
- **传播**：重生前为 1 个 spawn、2–4 个建筑、0 个 creep（M1 部署后的稳态，即官服当前的状态），重生后数量相同，不触发完整判定。`maintain`（第 343–345 行）用放置之后的 tick 覆盖 `lastRun`，到下一个整百 tick 把新 spawn 写进 `fp`，之后任何完整判定都落入 11.4 d NORMAL。
- **平台**：backend `lib/utils.js` 第 115–167 行 `respawnUser` 删除对象；driver `lib/runtime/data.js` 第 105–108 行把无对象的玩家置为非活跃；`user-vm.js` 第 160–162 行只回收闲置超过 3 分钟的 VM。所以 3 分钟内重新放置 spawn 时仍是同一 global。
- **影响**：FRESH_START、备份、清空与 epoch 加 1 都不发生，上一局的 Memory 被直接认领。调为 P3 的理由：M2 起房间里通常有 creep，重生时 creep 数从非 0 变为 0，`jumped` 会触发完整判定；完全不变的组合主要出现在 M1 稳态。
- **建议**：在廉价不变量中加入 tick 连续性（`time !== 上次 + 1` 时完整判定，O(1)），玩家非活跃期间代码不执行，重生必然造成 tick 断档。须你对架构 11.1 的指令。

### S-08 · P3 · 11.4 c 的清空被拦下后，冻结在下一次完整判定时解除

**证据：源码确认、测试复现。来源：B2，DV-03 整改未覆盖的 lastRun 通道。**

- **传播**：清空被 `autoClear` 关闭或备份失败拦下（[boot/index.ts](../../src/app/boot/index.ts#L238) 第 238–241 行），置 `frozen`，模式写为 AMBIGUOUS。creep 0→1 触发完整判定，`judge` 第 320 行先把 `frozen` 清零；W 不成立，走"保持 AMBIGUOUS"（[assess.ts](../../src/app/boot/assess.ts#L204) 第 204–205 行），动作为 none，`frozen` 保持 false，`maintain` 恢复写 `lastRun`（DV-03 只阻止了 `fp`）。creep 消失、W 恢复后，时钟可用且 `lastRun` 不早于放置，判为 11.4 d NORMAL 并写入 `fp`。
- **影响**：未经人工确认认领上一局的 Memory。备份容量约 1 MB（BACKUP_CAPACITY），更大的 Memory 备份必然失败，这条路径在默认 `autoClear` 下同样可达。
- **建议**：冻结条件改为持久化的事实（例如模式为 AMBIGUOUS 且证据来自 11.4 c/c′ 时一律不写 `lastRun` 与 `fp`），而不是 heap 中随完整判定清零的 `frozen`；须同步 boot 设计第 4.2、6.1 节。

### S-09 · P3 · 非 FRESH_START 的 boot.force 永久生效

**类别：范围内修正（设计取舍，须修订 boot 设计）。证据：源码确认、测试复现。来源：B3。**

- `assess` 在 `force` 不为空时直接返回指定模式（[assess.ts](../../src/app/boot/assess.ts#L105) 第 105–111 行）；只有 FRESH_START 是一次性的（[boot/index.ts](../../src/app/boot/index.ts#L252) 第 252、255、279 行），其他模式经 `part.boot.control` 跨 global reset 保留。
- "保持 AMBIGUOUS，等待人工 boot.force"的证据文本（assess.ts 第 205 行）把 force 当作确认手段，但确认需要 `force(mode)` 再 `force()` 两步，设计与通知都没有说明。漏掉第二步时，之后的重生与 RECOVERY 都不再判定，`maintain` 照常覆盖重生证据。实现符合 [boot 设计](../design/app/boot.md)第 8 节。
- 建议：AMBIGUOUS 的确认改为一次性指定（与 FRESH_START 相同），或在证据与通知中写明须取消；须修订 boot 设计。

### S-10 · P4 · 运行中途重生经软重置时，通知发两次

**证据：测试复现。来源：B5。** 旧实例判为 FRESH_START 后走软重置分支（hold 为真，[boot/index.ts](../../src/app/boot/index.ts#L300) 第 300 行不写 `sys.mode`），但 `publish` 已发通知；新实例的 `view` 为空，第 295–296 行以持久化的 NORMAL 为基准，再通知一次。违反 boot 设计"模式变化的通知只发一次"。建议 hold 时不通知，或以持久化的模式与 heap 中待发通知去重。

### S-11 · P4 · 从 control 分区读回的 force 不校验

**证据：测试复现。来源：B7。** `syncForce`（[boot/index.ts](../../src/app/boot/index.ts#L197) 第 197 行）原样采用分区中的值，控制台入口（第 366 行）才按 `BOOT_MODES` 校验。手工编辑出的非法模式被发布给 kernel，写入 `sys.mode` 后提交时 `checkMarker` 拒绝并隔离 sys（[commit.ts](../../src/kernel/memory/commit.ts#L82) 第 82–87 行），此后 `lastRun`、`fp`、`release`、`mode` 都不再持久化。建议读回时校验，非法值按 null 处理并告警。

### S-12 · P3 · 被清单拒绝的模块在状态与统计中看不到

**证据：测试复现。来源：KC4、D2。**

- 运行记录只由 `plan.order` 创建（[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L183) 第 183–184 行），拒绝原因只在创建 kernel 时记一条日志（第 188 行）；`ops.status`（[ops.ts](../../src/kernel/lifecycle/ops.ts#L306) 第 306 行）、`ops.status(id)`（[app/ops](../../src/app/ops/index.ts#L103) 第 103–104 行报"未知模块"）与统计页的 `down`（ops.ts 第 382 行）都只看运行记录；`refresh` 还把它的启停记录报成"未知模块"。
- 生存层模块被拒时健康恒为 degraded（第 187、367 行），第 3 个 tick 起追加保底，状态里却没有任何一行说明原因。违反 [ops 设计](../design/app/ops.md)第 2 节"显示每个模块的状态（含初始化失败）"。
- 建议：状态快照与统计页中列出被拒模块，状态为 failed 并附原因。

### S-13 · P4 · 空 id 的生存层模块被拒绝后不计入健康

**证据：测试复现。来源：KC5。** [process/index.ts](../../src/kernel/process/index.ts#L64) 第 64 行以"（空 id）"为键记录，[lifecycle/index.ts](../../src/kernel/lifecycle/index.ts#L187) 第 187 行用 `m.id`（空串）反查，查不到，健康仍为 ok。建议 `rejectedSurvival` 直接在规划时按层级统计。

### S-14 · P4 · 启停标志中的非法值被当作 run

**证据：测试复现。来源：KC6。** [ops.ts](../../src/kernel/lifecycle/ops.ts#L186) 第 186 行对非 `'pause'` 的任何已有值都判为不暂停，`value()`（第 202–205 行）却返回 undefined，`ops.status` 显示"默认暂停"而模块在运行，没有告警。来源只可能是手工编辑 Memory。建议非法值按没有记录处理（取 `startPaused`）并告警一次。

### S-15 · P4 · ops.unset 不能清除已移除模块或生存层模块的记录

**类别：范围内修正，须同步 ops 设计第 3.2、4 节。证据：测试复现。来源：D3。** `createSwitches.set`（[ops.ts](../../src/kernel/lifecycle/ops.ts#L213) 第 213–220 行）在判断 value 之前就对未知 id 与生存层 id 抛错，清除也被拒绝；这些记录只能手工编辑 Memory，每个 kernel 实例都重复告警，同 id 模块重新加入时旧的 pause 静默生效；错误文本对 unset 写着"不能暂停"。建议 value 为 undefined 时允许删除任何记录。

### S-16 · P4 · ops.log 不能调整 boot 与 kernel 自身的作用域

**类别：新增 API 或功能。证据：测试复现。来源：D5。** `ops.log` 带作用域时经 `resolveProcess` 只查模块表（[ops.ts](../../src/kernel/lifecycle/ops.ts#L245) 第 245–255 行），boot、kernel、memory、segments、stats、main 都返回"未知进程"；main 作用域每次调用新建（[main.ts](../../src/main.ts#L340) 第 340、352 行），即使开放查找也保留不了覆盖。M1 清单为空，单独打开 boot 的 debug 只能全局打开。

### S-17 · P3 · CpuBudget 契约与实现不一致

**证据：测试复现。来源：LC1。**

- 契约（[contracts/cpu.ts](../../src/contracts/cpu.ts#L12) 第 12、16–20 行，contracts 设计第 149 行）写"本进程本 tick 剩余"；实现（[cpu/index.ts](../../src/kernel/cpu/index.ts#L195) 第 195–210 行）每层只有一个视图，非生存层 `remaining = poolEnd − cpuUsed`，不扣除其他已准入进程尚未运行阶段的预计耗用；lifecycle 只在 hardEnd 刹车。
- 影响：早期阶段按 `shouldYield` 自适应的长计算会把读数推到 poolEnd，之后其他已准入进程的 act/move 照常执行，总耗用超出 B 并吃掉收尾预留。复现：limit 20，三个经济层进程预计 2、5、5，长计算停在 18 后其余两个各耗 5，读数为 28。cpu 设计第 88 行"不会越过上限"只对长计算自身成立。
- 建议：修正契约文字为"本层共用剩余"，并让 `remaining` 扣除本 tick 已准入、尚未运行的进程的预计值；或在设计中写明长计算只能放在本层最后的阶段。

### S-18 · P3 · 保底应急孵化会覆盖正常循环同 tick 的孵化意图

**证据：源码确认、测试复现（按引擎语义的替身）。来源：E1，KS-03 整改的缺口。**

- 保底判断接替者与空闲 spawn 都依据 tick 起点的 `spawn.spawning`（[fallback.ts](../../src/fallback.ts#L226) 第 226–232 行）。引擎在同 tick 成功调用 `spawnCreep` 时只把占位 creep 放进 `Game.creeps`、不改 `spawning`（engine `src/game/structures.js` 第 861、1096、1132–1133 行），并以 `intents.set(id, 'createCreep', …)` 登记（第 1215 行）；driver `runtime.js` 第 66–72 行对同一对象的同名 intent 直接覆盖。
- 影响：degraded 追加保底的 tick 与正常循环抛错的 tick，保底在同一 spawn 上再次 `spawnCreep`，返回 OK 并覆盖正常循环的孵化。第 219 行注释与 [fallback 设计](../design/fallback.md)第 28 行"也覆盖正常循环当 tick 已孵化的情形"不成立。M2 孵化模块接入后可触发。
- 建议：接替者判断改为检查 `Game.creeps` 中 `spawning` 为 true 且位于该 spawn 的占位 creep；同时修正注释与设计文字。

### S-19 · P3 · 保底的寻路名额与预留按遍历顺序分配

**证据：测试复现。来源：E2。**

- 全局寻路名额 20 次/tick（[fallback.ts](../../src/fallback.ts#L459) 第 459–461 行）按固定的房间与 creep 顺序消耗（第 86–96 行），平台的 `Game.rooms` 顺序也稳定；`pick`（第 282–288 行）在确认能否移动之前就预留目标容量，不回滚。
- 影响：多房间时前面房间的普通移动每 tick 先耗尽名额，后面房间的防降级升级者与补能搬运者持续不动，违反架构 5.7"先保障紧急防降级与补能链"；名额耗尽时，不动的远处 creep 占住预留，挡住紧挨目标的 creep 就地补能。复现：W1N1 有 20 个需要寻路的工人时，W2N2 的应急升级者连续 3 tick 没有动作。
- 建议：先为各房间的防降级升级者与补能链分配名额，再按房间轮转；寻路失败时回滚预留，或改为"能动作再预留"。

### S-20 · P4 · 保底对疲劳 creep 照常寻路

**类别：简化，运行依据：减少无效的原生寻路并释放名额。来源：E3。** `step`（[fallback.ts](../../src/fallback.ts#L459) 第 459–473 行）不检查 `fatigue`，疲劳 tick 的 `PathFinder.search` 结果必然作废（engine `creeps.js` 第 144–146 行 `move` 返回 ERR_TIRED），还占用一个名额。引擎的 `moveTo` 在寻路前就做同样的判断（第 173–175 行）。建议 `fatigue > 0` 时直接返回。

### S-21 · P4 · 保底按部件推断角色，规划体型的矿工会离开 source

**类别：范围内修正，须先修订定稿的 fallback 设计。证据：测试复现。来源：E4（部分成立，核实者修正了机制）。**

- 代码与 [fallback 设计](../design/fallback.md)第 37–42 行的分工表一致，但该表没有覆盖 [app.config](../design/app/config.md) 第 50 行规划的矿工体型。
- link 矿工（5W+1C+1M）被归为工人：装满 50 能量就去补能；空载且房间有 storage 或 container 能量时，即使紧挨活跃 source 也会离开去取能（第 323 行的 `acquire`）。无 CARRY 的容器矿工在所守 source 暂时枯竭时会走向另一个 source，所守 source 再生后被选回，损失的是离岗与折返时间。
- 影响：保底期间采集产能明显下降，有 storage 时不会立即断供。

### S-22 · P3 · 存在 logUnsafe 而关闭上色时，日志正文按 HTML 渲染

**证据：源码确认、测试复现、平台源码。来源：D1。**

- `consoleSink`（[assembly/index.ts](../../src/app/assembly/index.ts#L52) 第 52–74 行）只要 `console.logUnsafe` 存在就选它；第 153 行 `color: output.html && loggerSettings.color` 把"输出端渲染 HTML"与"是否上色"合成一个开关；logger 的非上色分支（[logger/index.ts](../../src/kernel/logger/index.ts#L251) 第 251–253 行）不转义也不换 `<br>`。engine `src/game/console.js` 第 30–46 行的 logUnsafe 以 `escape: false` 下发，driver `lib/index.js` 第 367 行不编码。
- 影响：把 `loggerSettings.color` 改为 false 时，正文与堆栈（可能含外来名称）原样按 HTML 渲染。assembly 第 49 行与 `contracts/settings.ts` 第 14 行的注释与这一行为矛盾。默认设置下不触发。
- 建议：转义只取决于输出端是否渲染 HTML，上色单独开关；同步内核设计第 5 节。

### S-23 · P4 · 控制台命令结果不经平台编码

**类别：范围内修正，后果待验证。证据：平台源码。来源：D4（部分成立）。** engine `game.js` 第 535–544 行把命令结果交给 `commandResult`（`console.js` 第 49–55 行，没有 escape 标记），driver 与 backend 都不编码，和 logUnsafe 的内容一样原样下发。如果客户端像内核设计第 5 节认定的那样按 HTML 渲染，`ops.status()` 与 `help()` 的多行结果会被折叠，含 `<`、`&` 的片段会被误解析。客户端闭源，须在官服执行 `ops.help()` 确认后再决定是否在 [console](../../src/kernel/console/index.ts#L103) 的 `formatResult`（第 103–113 行）中转义。

### S-24 · P3 · 加载时对整个根执行 validateJson

**类别：简化，运行依据：每次 global reset、软重置与崩溃重建首个 tick 的加载成本，并缩小 S-01 的窗口。证据：源码确认、Node 基准（只作量级参考）。来源：M3、CR3。**

- [runtime.ts](../../src/kernel/memory/runtime.ts#L183) 第 183 行对 `JSON.parse` 的结果执行完整的 `validateJson`（[json.ts](../../src/kernel/memory/json.ts#L31) 第 31–82 行：每个容器 `Reflect.ownKeys` 与祖先集合，每个属性一个描述符对象，数组下标一次正则）。`JSON.parse` 的产物只可能在非有限数字上违反纯数据规则（溢出为 ±Infinity），其余检查恒定通过。
- Node 24 基准：字符串为主的 1.2 M 字符 Memory，parse 5.1 ms、validateJson 8.7 ms、只查非有限数 1.7 ms；数字数组为主的 1.5 M 字符，parse 7.5 ms、validateJson 56 ms、只查非有限数 4.2 ms。
- 注释：[main.ts](../../src/main.ts#L208) 第 208–209 行与内核设计第 6 节称冷却"把这项成本限制在每 KERNEL_COOLDOWN tick 一次"，实际要连续 3 次失败才进入冷却，约每 104 tick 加载 3 次；[json.ts](../../src/kernel/memory/json.ts#L6) 第 6 行"仅在实际写入/脏编码时使用"与加载路径不符。
- 建议：加载改用只检查非有限数的遍历，拒绝语义不变（[Memory 方法复核](./2026-10-19-memory-simplification.md)保留加载校验的理由是拒绝 Infinity，不受影响）；修正两处注释。

### S-25 · P4 · 实体切片查找每次都 JSON.stringify 三元组键

**类别：简化，运行依据：M2 起每 tick 按 creep × 模块调用。证据：源码确认、Node 基准。来源：M5、CR5（两位核实者分别定为 P4 与 P3，本报告取 P4：目前没有使用方）。** `of()`、`has()`（[entities.ts](../../src/kernel/memory/entities.ts#L79) 第 79、100 行）与 `partition()`（partitions.ts 第 43 行）每次都分配数组并 `JSON.stringify` 成 `unitId`（runtime.ts 第 161 行）后查表；`maintain` 每个切片再做 1–2 次（第 146、151 行）。1000 个名称 × 3 个 owner 的 Node 基准：0.59 ms 对分层 Map 的 0.056 ms。建议在切片闭包内按实体键缓存单元（命中时检查 `active`），`maintain` 经 `byRecord` 取单元，契约不变。

### S-26 · P4 · geometry 文件摘要与 packWorld 的分配不符

**证据：源码确认。来源：LC2。** [geometry/index.ts](../../src/lib/geometry/index.ts#L9) 第 9 行把"打包"列为零分配，但 `packWorld`（第 100–106 行）每次经 `roomCoords`（第 49–55 行）执行正则并新建对象，与 [geometry 设计](../design/lib/geometry.md)第 50 行"适合在缓存建立时调用一次"相矛盾。目前没有调用方。建议修正摘要，并在 `packWorld` 的 JSDoc 中写明成本。

### S-27 · P4 · 备份按 UTF-16 码元切页

**证据：测试复现；存储层后果为待验证推断。来源：PA2（部分成立）。** [backup.ts](../../src/kernel/bootPort/backup.ts#L90) 第 90 行按码元以 102,272 切分，可能把非 BMP 字符的代理对拆到相邻两页（复现：页 80 末尾 0xd83d、页 81 开头 0xde00）。公开 driver 在 Node 12 及以上经 JSON 转义孤立代理，往返无损，备份正常完成；若存储以 utf8 写入且不转义（旧版私服，或官服若如此实现），超过一页且切分点恰为非 BMP 字符的 Memory 会确定性地备份失败，boot 改判 AMBIGUOUS、不清空。结果偏向安全。建议页末为高位代理时少取一个码元，并按实际页数检查容量。

## 附录：范围外（测试与配置）

以下各项指向 `test/` 或配置，不属于 src 业务代码，只记录：

| 编号 | 问题 | 来源编号 |
| --- | --- | --- |
| X-01 | boot 测试不能证明"中证据须两次一致"与廉价不变量的突变阈值：把 `boot/index.ts` 第 261 行的闸门改为 `if (false)`、或删去第 82 行的"减少一半以上"、或删去第 91 行建筑数的判断，`test/app/boot` 的 37 项仍全部通过（对照变异有 4 项失败） | B4 |
| X-02 | 混沌测试与平台替身只模拟 `halt`（isolate 销毁），没有"CPU 超时后 heap 保留、继续同一 global"的扰动；S-01 至 S-06 的回归测试可以用 `node:vm` 的 timeout 在指定注入点终止 tick | CR4 |
| X-03 | `tsconfig.test.json` 继承 `isolatedModules: true`，ts-jest 29.4.15 只转译、不做类型检查；`test/contracts/memory.test.ts` 第 3 行"ts-jest 也会检查本文件"不成立，契约类型断言只由 `npm run typecheck` 检查 | LC3 |
| X-04 | 增量拼接与全量编码等价的测试对键序的证明力有限（自我比较、单单元用例）；`commit.ts` 的拼接本身与独立模型逐字一致，没有缺陷。核实者判为不属于 src | M4（推翻） |

## 其他观察（未列为问题）

- 每 tick 的 Memory 写入：项目标记的 `lastRun` 每 tick 更新（架构 6.7），sys 每 tick 变脏，所以每 tick 都重拼整个根文本、调用一次 `RawMemory.set`，下一 tick 再整串比较一次待确认文本（`runtime.ts` 第 330 行）。架构 6.2 的"没有脏单元的 tick 不写入"在实际运行中不会出现；成本与 Memory 总长度成正比。这是设计取舍，`stats` 的 `cpu.finish` 已经能观测它，是否处理留给 14.4 的数据触发。
- 名称集合每 tick 分配两次：`GamePort.creepNames()` 与 `flagNames()` 每 tick 新建 Set（`assembly/index.ts` 第 120、125 行），`beginTick` 按契约再复制一次（`runtime.ts` 第 310 行）。规模为 O(creep 数)，很小。

## 待补

完整性审查（找子系统交界处的问题、未覆盖的文件与被错误推翻的方向）在本报告写成时仍在运行，结果出来后追加在这里。
