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

## 关闭方案（2026-10-21，待批准）

- 分支：`fix/audit-0.1.18`，基于本报告的提交 `e91739c`（即 `cb51f01` 加本报告）。本节只是计划，没有修改代码。
- 依据：在本报告基线上逐项重读源码；S-18 另核对了 `@screeps/engine` 4.3.2 `src/game/structures.js` 第 1132–1160 行。
- 每项写明做法、须同步或须授权的文档、回归测试与反向验证。需要取舍的项列出选项并标明建议，由你逐项决定；没有取舍的项按所列做法实施。
- 章程：只有 S-07 需要修订架构 11.1（第 1209 行），须你的明确指令。第一组的方案 A 符合架构 5.7 第 378 行"在后续 tick 根据可用故障证据提前接管"，不改章程。
- 设计：内核设计第 5、6 节，boot 设计第 5–9 节，ops 设计第 2、3.2、4 节，fallback 设计，cpu 设计与 contracts 第 4 节，都随对应的项修订，各项分别写明。
- "待补"一节的完整性审查结果尚未取得，本方案只覆盖 S-01–S-27 与附录。

### 一、被硬终止后沿用同一实例（S-01–S-05）

这 5 项的根因相同：被硬终止的 tick 之后，入口继续使用同一个 kernel 实例。逐个修补窗口只能关掉已发现的窗口，以后新增的"先改状态、后完成"的代码还会再出现。

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 入口检测"上一 tick 未正常结束"。在 `assemble` 与 `kernel.tick()` 之前把闭包变量 `running` 置为 true，tick 正常返回或进入 catch 后清除。V8 的终止不执行 catch 与 finally，所以下一 tick 看到 `running` 仍为 true，就说明上一 tick 被终止。这时先把 kernel 置为 undefined，再在 try 中 dispose 旧实例；记录 `lastFailure`（"上一 tick 未正常结束（CPU 硬终止）"）和一条 error 日志；与抛错共用 `countCrash` 与冷却，计为一次失败；本 tick 运行保底，下一 tick 从已提交的文本重新装配。被终止的 tick 不保存 Memory 与 segment，重建得到的正是终止前的持久状态 | 每次终止多一次装配和完整的 Memory 解析。确定性的超限受 KERNEL_CRASH_LIMIT 与冷却限制，约每 103 tick 3 次。正常 tick 只多两次赋值。须修订内核设计第 6 节（第 196 行"计数只统计可捕获的异常"）与 main.ts 文件摘要第 10 行 |
| B | 逐个修补：S-01 在加载前锁存"加载未完成"的 `failure`；S-02 逐个模块记录是否已 setup；S-03 先完成准备，再以连续赋值同时更新根表与索引；S-04 入口在 tick 之前检查 `resetRequested()`，软重置分支设置 `rejudge` | 不增加重建成本，但要改 4 处，S-05 没有局部修法，以后新增的窗口照样存在 |

方案 A 下各项的关闭方式：

| 编号 | 关闭方式 |
| --- | --- |
| S-01 | 实例被丢弃，不会停在 `loaded = true`、`data` 为空的状态；FOREIGN 情形的 `initialize` 只会发生在已完成加载的新实例上，外来根键不再被删除 |
| S-02 | 同上；`modulesSetUp` 的置位顺序不再影响结果，不改 |
| S-03 | 同上；两步更新保持原样 |
| S-04 | 同上：登记软重置之后被终止，下一 tick 不再沿用旧实例，新实例的首个 tick 必然完整判定 |
| S-05 | 同上：新实例从已提交的文本（仍为 EMPTY）重建，重新判为 11.4 a 并初始化。清空终止在 `clearMemory` 与 `clearInterShard` 之间时，两者都没有持久化，新实例完整地重新执行 |

**回归测试**（同时补上附录 X-02 的缺口）：

- `test/main.test.ts`：在 `node:vm` 中运行 loop，用 timeout 终止假 kernel 的 tick。断言下一次 loop dispose 旧实例、计一次失败、本 tick 运行保底，再下一 tick 重新装配；连续 3 次后进入冷却。
- 集成测试：真实装配，在 `RawMemory.get` 与 `validateJson` 中终止（即 S-01 的复现）。断言之后的 tick 由新实例加载，`ops.status().memory` 为 ready，FOREIGN 情形下外来根键保留。
- **反向验证**：去掉 `running` 检测后，两项都失败。
- 私服场景：评估在 chaos 中加一种"超时"扰动（让代码在指定 tick 空转到 tickLimit）。做不到时，交付说明中写明只验证到 `node:vm` 这一层。

### 二、钩子越过 tickLimit（S-06，新增 API 或功能）

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 由第一组的方案 A 兜底：钩子被终止后整个 kernel 重建并计一次失败，连续 3 次进入 100 tick 冷却，不再每 tick 重复终止。内核设计第 6 节写明粒度：终止只归因到 kernel 整体，不归因到进程 | 一个模块的确定性超限会让所有模块随冷却停摆，期间只有保底在运行。M1 没有非生存层模块 |
| B | 在 A 之上按进程归因：lifecycle 调用钩子前，把进程键写入入口持有的槽位；入口检测到终止时，把这个键交给新 kernel，新 kernel 对该进程计一次失败（达到 BREAKER_THRESHOLD 时熔断），不再计入入口的失败次数 | 入口与 kernel 之间多一个接口；每次钩子调用多一次赋值。建议等 M2 第一个非生存层模块接入时再决定 |

回归测试见第一组；方案 B 另测：同一进程连续 3 次被终止后熔断，其他模块照常运行。

### 三、boot（S-07–S-11）

**S-07（须修订架构 11.1）**：boot 在 heap 中保存上次运行的 tick，`time !== 上次 + 1` 时完整判定，成本 O(1)。玩家没有对象时 driver 不运行其代码（`data.js` 第 105–108 行），所以同一 global 中的重生会造成 tick 断档。

- 须你授权：在架构 11.1 第 1209 行的廉价不变量中加入"tick 连续"；boot 设计第 5 节同步。
- 测试：同一实例的 time 从 100 跳到 105、三个数量不变时完整判定（以 `facts` 的调用次数确认）；相邻 tick 不触发。反向验证：去掉条件后失败。
- 残留：只有在一个 tick 的间隔内完成重生并放好 spawn 时才不会断档，实际上几乎不会发生。bucket 耗尽而跳过的 tick 也会触发完整判定，成本可以接受。

**S-08**：boot 设计第 6.1 节把冻结状态定为"保存在 heap，到下一次完整判定为止"，漏洞出在设计本身。

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 冻结持久化。`part.boot.control` 升到版本 2：`{ force, frozen }`，从版本 1 迁移时补 `frozen: false`。`blocked()` 在 Memory 属于本系统时写入 `frozen: true`；发布的模式不再是 AMBIGUOUS 时（人工确认，或清空完成后的新标记）写回 false。`maintain` 以分区中的值为准，不写 `lastRun` 与 `fp`；heap 中的 `frozen` 只在分区不可用时作后备 | 多一次分区版本迁移，只在冻结状态变化时写入。`lastRun` 冻结后，W 恢复且时钟不可用时可能落入 c′ 并再次尝试清空。这时的冻结本来就来自重生判定，清空正是原判定的结论，仍受 autoClear 与备份闸门约束。须修订 boot 设计第 6.1 节（"冻结状态保存在 heap"一段）、第 7 节与第 9 节（分区的初始数据） |
| B | 只改 heap：`judge` 不再无条件清除 `frozen`，只在发布的模式不是 AMBIGUOUS 时清除 | 改动最小，但 global reset 后若 W 不成立，仍会解冻（第 6.1 节所说的"按事实重新得出"），漏洞的 global reset 版本仍在 |

测试：本报告的复现序列（拦下 → creep 0→1 → 1→0），以及在 creep 为 1 时重建实例（模拟 global reset）。两种情况最终都不判为 NORMAL，`lastRun` 保持不变。反向验证：换回基线的 `boot/index.ts` 后失败。

**S-09**：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 所有人工指定都改为一次性：下一次完整判定采用后，同时清除 heap 与分区中的值；发布的模式经 `sys.mode` 持久化，之后恢复自动判定。AMBIGUOUS 的确认（例如 `boot.force('NORMAL')`）一步完成。assess.ts 第 205 行的证据文本改为"等待人工 boot.force(mode) 确认" | 不再支持长期压住自动判定的用法；目前没有这种用法，需要观察时用 dryRun。须修订 boot 设计第 8 节的表（"跨 global reset 保留"改为"保留到下一次完整判定采用为止"） |
| B | 保持持久生效，在证据、通知与 `ops.status` 中写明"人工指定生效中，须 boot.force() 取消" | 安全性仍取决于有没有人记得第二步 |

测试：AMBIGUOUS 下执行 `force('NORMAL')`，下一 tick 为 NORMAL；之后发生重生（不变量突变）时，判定按自动规则得出 11.4 c。反向验证：换回基线后失败。

**S-10**：`hold` 为真时只调用 `setMode`，不通知，也不更新通知的比较基准；基准改为一个独立的 heap 变量，不再复用 `view`。由动作完成的那一次发布来通知（同一实例备份完成后，或软重置后的新实例）。boot 设计第 6.2 节的通知一条同步修改。测试：运行中途重生 → 软重置 → 新实例判为 FRESH_START，`notify` 只调用一次；中证据备份跨 tick 时同样只通知一次。反向验证：基线下调用两次。

**S-11**：`syncForce` 读回时按 `BOOT_MODES` 校验；非法值按 null 处理，写回 null 并告警一次。测试：分区中写入非法模式后，判定按自动规则进行，sys 没有被隔离，告警一次。反向验证：换回基线后 sys 被隔离。

### 四、模块清单与运维（S-12–S-16）

**S-12**：`KernelStatus.modules`（kernel 内部类型，[ops.ts](../../src/kernel/lifecycle/ops.ts#L51) 第 51、67 行，不属于 contracts）加入被拒模块：状态为 `failed`，新增可选字段 `reason`，层级取定义中的值，空 id 显示为"（空 id）"。统计页的 `down` 包含被拒模块；app.ops 的 `formatStatus` 显示原因，`ops.status(id)` 能查到它们；`switches.refresh` 对被拒模块的启停记录不再报"未知模块"。ops 设计第 2 节同步。测试：状态、单个模块的状态与统计页都能看到被拒的模块和原因。反向验证：换回基线后失败。

**S-13**：`rejectedSurvival` 改为"清单中有层级为 survival、但不在 `plan.order` 中的模块"，不再按 id 反查。测试：空 id 的生存层模块使健康为 degraded。反向验证：基线下为 ok。

**S-14**：`refresh` 遇到 `'pause'`、`'run'` 与 undefined 以外的值时，按没有记录处理（取 `startPaused`），每个 id 告警一次。测试：非法值加上 `startPaused` 时模块保持暂停，告警一次。反向验证：基线下模块在运行。

**S-15**：value 为 undefined 时，允许清除任何 id 的记录（未知模块、生存层模块），只要求 Memory 可用；设为 pause 或 run 仍按现有规则拒绝。错误文本按动作区分，清除不再报"不能暂停"。ops 设计第 3.2、4 节同步。测试：已移除模块与生存层模块的记录都能清除，之后不再告警。反向验证：基线下抛错。

**S-16（新增 API 或功能）**：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 本轮不做，按"不采纳"关闭，有实际使用方时再提。M1 调试 boot 时用全局级别开关 | 只想看 boot 的 debug 时，必须打开全部 debug |
| B | logger 的作用域覆盖改为存在根对象中、按作用域名共享，任何 `scope(name)` 都取到同一份覆盖；`ops.log` 对非模块名直接作用于 `logRoot.scope(name)` | 修订 logger 设计，新增运维能力 |

### 五、CPU 预算（S-17）

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 契约与实现对齐：[contracts/cpu.ts](../../src/contracts/cpu.ts#L16) 第 12、16–20 行与 contracts 设计第 149 行改为"本进程所在层本 tick 剩余（同层进程共用）"；cpu 设计第 88 行写明 `shouldYield` 只保证长计算自身不越过 poolEnd，同层随后运行的已准入进程由 hardEnd 紧急刹车兜底 | 总耗用超出 B、吃掉收尾预留的情形保留下来。M1 没有 `shouldYield` 的使用方；方案 B 留到 M2 第一个长计算模块接入时再决定 |
| B | `remaining` 扣除本 tick 其他已准入、尚未运行完的进程的预计值：kernel.cpu 维护 `outstanding = Σ max(0, expected − spent)`，每次钩子计量后更新，成本 O(1)；预算视图改为每个进程一个，创建时分配一次 | 每个钩子多一次减法；视图对象数随进程数增长；预计值偏差会让扣除过多或不足。须修订 cpu 设计第 105–108 行的表 |

测试：本报告的复现（limit 20，预计 2、5、5）。方案 A 测文字所述的行为（长计算停在 poolEnd）；方案 B 测长计算停在 13，总读数不超过 B。反向验证：方案 B 换回基线后失败。

### 六、保底（S-18–S-21）

**S-18**：引擎在同 tick 成功调用 `spawnCreep` 后，`Game.creeps[name]` 中是一个位于 spawn 坐标、`spawning` 恒为 true、带 `body`、没有 id 的占位对象（engine `structures.js` 第 1132–1160 行）。判断接替者与空闲 spawn 时，除 `spawn.spawning` 外，另查 `Game.creeps` 中 `spawning` 为 true、位于该 spawn 坐标的 creep：有这样的 creep 时 spawn 视为忙碌；其 `body` 含 WORK 时视为接替者。只在房间缺少可用采集者时遍历一次 `Game.creeps`。修正 fallback.ts 第 219 行的注释与 fallback 设计第 28 行。测试：替身中正常循环在同 tick 调用 `spawnCreep` 后运行保底，保底不再调用 `spawnCreep`。反向验证：换回基线后再次调用。

**S-19、S-20**：

- 工作阶段的顺序改为：先处理所有房间的防降级升级者，再按房间轮转，每个房间交替取一个 creep。前面房间的普通移动不再先耗尽寻路名额。
- 预留只在提交了动作（取能、转移或移动）时保留：`step` 返回是否提交了移动；没有提交时，调用方撤回 `pick` 的预留。
- S-20：`step` 开头遇到 `fatigue > 0` 直接返回"未移动"，不消耗名额。配合上一条，疲劳的 creep 也不占预留。
- fallback 设计同步修改工作顺序与预留规则。
- 测试：本报告的复现（W1N1 有 20 个需要寻路的工人时，W2N2 的应急升级者每 tick 都有动作）；名额耗尽时，紧挨目标的 creep 能就地补能；疲劳的 creep 不调用 `PathFinder.search`（以调用次数确认）。反向验证：换回基线后都失败。

**S-21（须先修订定稿的 fallback 设计）**：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 分工表中"矿工"按 app.config 第 50 行的体型定义：有 WORK 与 MOVE，紧挨某个 source（活跃与否都算），并且没有 CARRY，或 WORK ≥ 5 且 CARRY ≤ 1。矿工不离开：source 活跃时采集，装满后继续采集，能量按引擎规则落地或进入脚下的 container；source 枯竭时原地等待 | 升级者体型（WORK×k、1 CARRY）恰好紧挨 source 时也会被当作矿工，这种站位很少见。须修订 fallback 设计第 37–42 行的分工表 |
| B | 保持现状，在 fallback 设计中写明：按部件推断角色会降低规划体型的采集产能，属于可接受的降级（架构 5.7 不承诺维持产能） | 保底期间采集产能下降 |

测试（方案 A）：link 矿工紧挨活跃 source、storage 中有能量时，原地采集、不移动；所守 source 枯竭时，无 CARRY 的矿工不走向另一个 source。反向验证：基线下会移动。

### 七、日志与控制台输出（S-22、S-23）

**S-22**：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（建议） | 装配时，`loggerSettings.color` 为 false 就选 `console.log`（由平台编码），只有上色时才用 `logUnsafe`；logger 不改。修正 assembly 第 49 行与 `contracts/settings.ts` 第 14 行的注释，同步内核设计第 5 节 | 不上色时由平台编码，多行正文按平台的方式显示 |
| B | logger 分开 `html` 与 `color` 两个选项：输出端渲染 HTML 时总是转义并把换行换成 `<br>`，`color` 只控制前缀着色 | 改 `LoggerOptions` 与 logger 设计 |

测试：存在 `logUnsafe` 且 color 为 false 时，含 `<b>` 的正文经 `console.log` 输出（方案 A），或被转义（方案 B）。反向验证：基线下原样进入 `logUnsafe`。

**S-23（待验证）**：须先在官服控制台执行 `ops.help()`，确认多行结果是否被折叠。这是线上操作，须你执行或明确授权。如果被折叠，`formatResult` 在输出端渲染 HTML 时按 logger 的同一规则转义并换 `<br>`，补测试；如果没有被折叠，按"不成立"关闭，并在本报告中记录核实结果。

### 八、Memory 开销（S-24、S-25）

**S-24**：加载改用只检查非有限数的遍历。`JSON.parse` 的产物只有普通对象与数组：属性都是可枚举的数据属性，没有空洞、symbol 与循环，所以除非有限数外，`validateJson` 的其余检查恒定通过，拒绝语义不变。同时修正 [main.ts](../../src/main.ts#L208) 第 208–209 行与内核设计第 6 节的冷却说明（改为"每 KERNEL_COOLDOWN tick 至多 KERNEL_CRASH_LIMIT 次"），以及 json.ts 第 6 行。测试：深层数组中的 `1e400` 在加载时被拒绝；加载路径不调用 `validateJson`（以调用次数确认）。反向验证：去掉非有限数检查后，第一项失败。

**S-25**：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A | 现在实施：在切片声明中按实体键缓存单元，命中时检查 `active`；`maintain` 回收记录时同时删除缓存项，`clear` 时清空；`maintain` 经 `byRecord` 取单元。契约不变 | creep 名称一生只用一次，缓存必须随回收清理，否则 heap 持续增长。没有真实调用模式可供基准测试 |
| B（建议） | 转入 M2：第一个使用实体切片的模块接入时，按真实调用模式实施（缓存或分层索引）并做基准测试，然后关闭本项 | 推迟到有使用方时再处理；目前没有调用方，没有运行成本 |

### 九、注释与备份切页（S-26、S-27）

**S-26**：修正 geometry 文件摘要第 9 行（把 `packWorld` 从"不分配对象"中去掉），并在 `packWorld` 的 JSDoc 中写明成本：每次执行一次正则并新建对象，适合在建立缓存时调用。只改注释，不需要测试。

**S-27**：切页时，页末为高位代理（0xD800–0xDBFF）就少取一个码元；切完后检查实际页数不超过备份页数，超过时返回 failed，保留原有的长度预检。测试：切分点恰好落在代理对上的文本，每页都不含孤立代理，拼回后与原文相等；页数超出时返回 failed。反向验证：换回基线后第一项失败。

### 十、附录各项（范围外，只改测试）

| 编号 | 方案 |
| --- | --- |
| X-01 | 补充 boot 测试，杀死报告所列的 3 个变异（中证据须两次一致的闸门、"减少一半以上"、建筑数的判断）；反向验证就是这 3 个变异本身 |
| X-02 | 并入第一组的回归测试 |
| X-03 | 把 `test/contracts/memory.test.ts` 第 3 行的注释改为"契约类型断言由 `npm run typecheck` 检查" |
| X-04 | 不处理（已推翻） |

### 待你决定

1. S-01–S-05：方案 A 或 B（建议 A）。
2. S-06：方案 A 或 B（建议 A）。
3. S-07：是否授权修订架构 11.1 第 1209 行。
4. S-08：方案 A 或 B（建议 A）。
5. S-09：方案 A 或 B（建议 A）。
6. S-16：方案 A 或 B（建议 A，不采纳）。
7. S-17：方案 A 或 B（建议 A）。
8. S-21：方案 A 或 B（建议 A）。
9. S-22：方案 A 或 B（建议 A）。
10. S-23：由你在官服执行 `ops.help()` 并告诉我结果，或授权我执行。
11. S-25：方案 A 或 B（建议 B）。

其余各项（S-10–S-15、S-18–S-20、S-24、S-26、S-27 与附录）没有取舍，批准后按所列做法实施。全部完成后运行 `npm run check`、私服场景 boot-judgment、chaos、fallback-takeover、memory-takeover 与 kernel-smoke，以及 `git diff --check`；整改与复核记录另起一节追加在本报告中。

## 整改与复核记录（2026-10-21）

- 分支：`fix/audit-0.1.18`，基于本报告的提交 `e91739c`。
- 批准范围：S-07 授权修订架构 11.1；S-23 授权在官服执行 `ops.help()`；其余各项按"关闭方案"中的建议关闭，即 S-01–S-05、S-06、S-08、S-09、S-16、S-17、S-21、S-22 取方案 A，S-25 取方案 B，没有取舍的项按所列做法实施。
- 反向验证的做法：把被修改的源文件临时换回基线 `cb51f01` 的版本（或撤掉单处修改），确认对应的新测试失败，再恢复。变异类的项（X-01）在当前代码上施加变异。

### S-23 的核实

- 2026-10-21 经 API 在官服测试账户的 shard0 执行 `ops.help()`（该账户的代码当前运行在 shard0，发往 shard1 的命令没有代码执行），从控制台 websocket 取回命令结果的原始报文：结果原样下发，没有实体编码，`<模块 id>:<实例键>` 中的尖括号保持原样，换行为 `\n`。
- 官服客户端（`https://screeps.com/a/` 的 `build.min.js` 与 `components/game/editor-panel/console/console.html`）把日志与命令结果的 `\n` 都换成 `<br>`，再以 `ng:bind-html='message.text | trust'` 按 HTML 渲染，不做净化。
- 结论：部分成立。多行结果不会被折叠；`<…>` 片段会被当作标签吞掉，`&` 会被误解析。按方案在控制台结果中转义。同一事实也说明内核设计第 5 节"正文换行改为 `<br>`，否则多行堆栈会被折叠"的理由不成立，logger 的这一步与客户端的处理等价，代码保留，设计文字一并更正。

### 整改

| 编号 | 整改 | 回归测试 | 反向验证 |
| --- | --- | --- | --- |
| S-01–S-05 | 入口在装配与 `kernel.tick()` 期间置 `running`，正常走完（含软重置的清理）或进入 catch 时清除；下一 tick 发现仍为 true 时丢弃实例、记录失败、按一次失败计数，本 tick 运行保底，下一 tick 重新装配。修订内核设计第 6 节（"CPU 硬终止"一条、`KERNEL_CRASH_LIMIT`、接管通知的原因）与 main.ts 文件摘要。平台替身增加 `timeout` 选项：在 `node:vm` 中以超时运行 tick，结果作废、heap 保留（补附录 X-02） | `test/main.test.ts`：终止后下一 tick dispose 旧实例、计一次失败、运行保底，再下一 tick 重新装配；连续 3 次进入冷却；正常结束与抛错的 tick 不被误判。`test/chaos/termination.test.ts`：真实入口、kernel 与 boot，在 Memory 加载中途终止后新实例加载完成、模块 setup 并运行；只有外来根键时外来键保留；模块 setup 中途终止后全部模块重新 setup | 去掉检测：`test/main.test.ts` 2 项、`termination.test.ts` 3 项失败 |
| S-06 | 由上一行兜底：钩子被终止后整个 kernel 重建并计失败，连续 3 次进入冷却。内核设计第 6 节写明终止只归因到 kernel 整体 | 同上（连续终止进入冷却） | 同上 |
| S-07 | boot 在 heap 中保存上次运行的 tick，tick 断档时完整判定。修订架构 11.1 的廉价不变量（授权）与 boot 设计第 5 节 | 同一实例中 tick 断档时完整判定一次、相邻 tick 不判定；M1 稳态下数量不变的重生登记软重置、`lastRun` 不被覆盖 | 换回基线：2 项失败 |
| S-08 | `part.boot.control` 升到版本 2（`{force, frozen}`，从版本 1 迁移），冻结持久化，只在发布的模式不再是 AMBIGUOUS 时解除；`judge` 不再无条件清除冻结。修订 boot 设计第 6.1、7、9 节 | 拦下后 creep 0 → 1 → 0，`lastRun` 与 `fp` 保持冻结；creep 为 1 时重建实例后冻结仍从分区读回；人工确认后解除 | 换回基线：3 项失败 |
| S-09 | 人工指定被一次完整判定采用后即清除（heap 与分区）；清空尚待执行时保留，dryRun 期间不消耗。修订 assess.ts 的证据文本、控制台说明与 boot 设计第 8 节 | 原"M1 接手分支"用例改为一次性语义：`force('NORMAL')` 采用后分区中的指定为 null，重建后按自动判定 | 换回基线：失败 |
| S-10 | 通知的比较基准与 `view` 分开，清空尚待执行时只发布、不通知。修订 boot 设计第 6.2 节 | 运行中途重生经软重置，FRESH_START 只通知一次 | 换回基线：失败 |
| S-11 | `syncControl` 读回时校验人工指定，非法值按没有指定处理、清除并告警；版本 1 迁移时同样只保留合法值 | 版本 1 与版本 2 的非法值都按没有指定处理，sys 照常持久化；版本 1 的合法指定迁移后被采用一次 | 换回基线：版本 1 的 2 项失败（基线把版本 2 当作未知版本丢弃，那一项碰巧通过）；去掉 `syncControl` 中的校验：版本 2 的一项失败 |
| S-12 | 被拒模块整理为 `RejectedModule` 列表：状态快照中列为 failed 并附 `reason`，统计页的 `down` 包含它们，启停标志不把它们的记录报成未知模块，`ops.status` 显示原因。修订 ops 设计第 2 节与 stats 设计第 2 节 | `test/kernel/lifecycle/ops.test.ts`：状态、统计页与告警；`test/app/ops.test.ts`：`status` 与 `status(id)` 显示原因 | 换回基线：失败 |
| S-13 | 被拒的生存层模块改为"清单中层级为 survival、不在执行顺序中的模块"，不再按 id 反查 | 空 id 的生存层模块使健康为 degraded，状态中显示为"（空 id）" | 换回基线：失败 |
| S-14 | `refresh` 把 pause、run 以外的值按没有记录处理（取 `startPaused`），每个 id 告警一次。修订 ops 设计第 3.2 节 | 非法值加上 `startPaused` 时模块保持暂停，告警一次 | 换回基线：失败 |
| S-15 | 清除接受任何 id 的记录，只要求 Memory 可用；设置覆盖仍按原规则拒绝，错误文本按动作区分。修订 ops 设计第 2、3.2、4 节 | 已移除模块与生存层模块的记录都能清除，重建后不再告警；`ops.unset` 能清除被拒模块的记录 | 换回基线：失败 |
| S-16 | 不采纳，按方案 A 关闭；有实际使用方时再提 | — | — |
| S-17 | 契约与实现对齐：`CpuBudget` 的文字改为"本进程所在层本 tick 剩余（同层进程共用）"，同步 contracts 设计第 4 节；cpu 设计第 3.2 节"预热"一条与第 4 节写明 `shouldYield` 只保证调用方自身不越过本层上限，其余由紧急刹车兜底。方案 B 留到 M2 第一个长计算模块接入时再决定 | 文字修改；按层计算的行为由现有 cpu 测试覆盖 | — |
| S-18 | 判断接替者与空闲 spawn 时另查 `Game.creeps` 中位于 spawn 坐标、正在孵化的 creep（含同 tick 的占位对象）；只在房间缺少采集者时遍历。保底测试的替身按引擎语义在 `spawnCreep` 后放入占位 creep。修订 fallback 设计第 2 阶段与验证一节 | 正常循环同 tick 已孵化带 WORK 的 creep 时保底不再孵化；同 tick 孵化的不是采集者时改用其他空闲 spawn | 换回基线：2 项失败 |
| S-19 | 工作阶段先处理所有房间的防降级升级者，再按房间轮转；`step` 返回是否提交了移动，没有移动时撤回 `pick` 的预留。修订 fallback 设计第 3 阶段、预留与寻路两节 | 前面房间的 20 个寻路工人不饿死后面房间的应急升级者与普通工人；名额用尽时远处 creep 的预留被撤回，紧挨供给的 creep 照常取能 | 换回基线：2 项失败 |
| S-20 | `step` 遇到 `fatigue > 0` 直接返回，不寻路、不占名额 | 疲劳的 creep 不调用寻路，并撤回预留，紧挨目标的 creep 就地补能 | 换回基线：失败 |
| S-21 | 矿工按体型识别（没有 CARRY，或 WORK ≥ 5 且 CARRY ≤ 1），紧挨任一 source 时守在原地，source 活跃才采集。修订 fallback 设计的分工表 | link 矿工空载与装满时都原地采集；所守 source 枯竭时无 CARRY 的矿工原地等待 | 换回基线：3 项失败 |
| S-22 | `consoleSink(color)`：只有要上色且存在 `logUnsafe` 时才用它，否则用 `console.log`。修订 `contracts/settings.ts` 与 assembly 的注释、内核设计第 5 节 | 存在 `logUnsafe` 而关闭上色时，`<b>` 正文经 `console.log` 输出 | 换回基线：失败 |
| S-23 | 控制台的命令结果、错误文本、`help()` 与设置读取到的字符串转义 `&`、`<`、`>`，换行保持原样。修订 console 设计第 5 节（新增"转义"一条） | 结果、错误、help 与设置字符串的转义，换行不变 | 换回基线：失败 |
| S-24 | 加载改用 `checkParsed`（只查非有限数）；修正 main.ts 冷却说明、json.ts 文件摘要、内核设计第 6 节的冷却说明与 memory 设计中的加载说明 | 深层数组中的 `-1e400` 在加载时被拒绝；加载路径不调用 `validateJson`；`checkParsed` 与 `validateJson` 对 `JSON.parse` 的产物结论相同 | 去掉非有限数检查：2 项失败；加载换回基线：1 项失败 |
| S-25 | 按方案 B 转入 M2：第一个使用实体切片的模块接入时，按真实调用模式实施并做基准测试，然后关闭本项 | — | — |
| S-26 | 修正 geometry 文件摘要与 `packWorld` 的 JSDoc | 注释修改，不需要测试 | — |
| S-27 | 切页时页末为高位代理就少取一个码元；切完后按实际页数检查容量。修订 bootPort 设计第 3 节 | 切分点落在代理对上时代理对留在下一页、拼回相等；实际页数超出时为 failed | 换回基线：2 项失败 |
| X-01 | 补充 boot 测试：备份立即完成时中证据只判定一次不清空；建筑数减少一半以上、creep 数减少一半以上、建筑数归零都触发完整判定 | 同左 | 闸门改为 `if (false)`：1 项失败；删去"减少一半以上"：2 项失败；删去建筑数的判断：2 项失败 |
| X-02 | 并入 S-01–S-05 的测试；混沌测试未加随机超时扰动：确定性的终止测试已覆盖检测与恢复，随机扰动要把"终止 → 保底 → 重建 → 冷却"的规则加进混沌测试的推算模型，收益不抵复杂度 | 见 S-01–S-05 | 见 S-01–S-05 |
| X-03 | 改正 `test/contracts/memory.test.ts` 的文件摘要：契约类型断言只由 `npm run typecheck` 检查 | 注释修改 | — |
| X-04 | 不处理（已推翻） | — | — |

**验证：**

- `npm run check` 通过：38 个套件、532 项测试，构建成功。
- 私服场景 7 个全部通过：boot-judgment、chaos、error-mapping、fallback-takeover、kernel-smoke、memory-takeover、module-reevaluation。首次运行时 kernel-smoke 与 memory-takeover 失败：`test/scenarios/support/harness.cjs` 的 `withRuntimePartitions` 写死了版本 1 的 control 分区，S-08 把它升到版本 2 后期望值随之改为 `{version: 2, data: {force: null, frozen: false}}`，两个场景重跑通过。
- `git diff --check` 通过。

**未解决的限制：**

- **S-01–S-06 的私服验证**：私服场景没有超时扰动，生产构建中没有让代码在指定 tick 空转的钩子；终止检测只验证到 `node:vm` 的超时这一层。"官服超时后保留 global"仍是推断，但检测在两种情况下都成立：global 被回收时标记随之丢失，新 global 中也没有可沿用的实例。
- **S-06 的粒度**：一个模块的确定性超限会让所有模块随冷却停摆；按进程归因（方案 B）留到 M2 第一个非生存层模块接入时再定。
- **S-07 的残留**：只有在一个 tick 的间隔内完成重生并放好 spawn 时才不会断档。bucket 耗尽而跳过的 tick 会多触发一次完整判定。
- **S-21 的边界**：升级者体型（WORK×k、1 CARRY）恰好紧挨 source 时也会被当作矿工守在原地。
- **S-17、S-25** 分别留到 M2 再决定或实施。
- **范围外观察**：控制台命令写入的人工指定（`boot.force`）与启停标志在下一 tick 的提交中才落盘；命令执行之后、下一 tick 提交之前发生 global reset 时会丢失。这是控制台在主循环之后运行的结果，设计"跨 global reset 保留"指已提交的指定。只记录，不处理。
- **"待补"一节按现状关闭**（2026-10-21 你的决定）：完整性审查的结果没有取得，本报告以 S-01–S-27 与附录 X-01–X-04 为最终范围，不再追加。
