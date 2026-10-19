# M1 第 2 步工作区交付审计（外部评审核实）

## 基线与范围

- 日期：2026-10-19。
- 分支：`feat/kernel-skeleton`；HEAD：`c828728`（与 dev 相同），审计对象为未提交工作区：
  - `src/fallback.ts`、`src/env.d.ts`；
  - `test/fallback/world.ts`、`test/fallback/fallback.test.ts`；
  - `docs/design/fallback.md`、`docs/design/kernel/README.md`、`docs/design/kernel/errorMapper.md`，以及设计索引的改动。
- 关键文件 SHA-256 前 12 位：

  | 文件 | 哈希 |
  | --- | --- |
  | `src/fallback.ts` | `8c8061b06864` |
  | `test/fallback/world.ts` | `26baf19ec574` |
  | `test/fallback/fallback.test.ts` | `c360f2206115` |
  | `docs/design/kernel/README.md` | `ac10365a904a` |
  | `docs/design/kernel/errorMapper.md` | `a47007d93833` |
  | `docs/design/fallback.md` | `3d389ee6403a` |

- 审计方式：用户指定调用 Codex（模型 `gpt-6-astra`，思考强度 `ultra`，只读沙箱，会话 `01a152f7-2bfd-7df0-a990-53a6477b7588`）作为外部审计员，其结论只作参考。本报告按 AGENTS.md 第 4 节"核实外部评审"，在上述基线上逐条核实，再给出评估。
- 前置检查：[挂起问题列表](./suspended.md) 为空；本轮只追加本报告与索引，不修改实现、测试或最高章程。

## 结论

Codex 的 15 项结论全部核实成立，评估结果为：
- 采纳 13 项；
- 采纳但调整级别 2 项：KS-01 由 P1 调为 P2，KS-15 由 P2 调为 P3。

**目前不具备合并条件**：
- 保底循环有一项会中断生存闭环的缺陷（KS-02）；
- 测试替身有三处与平台语义不符，造成假通过或未覆盖（KS-03、KS-07、KS-08）；
- 内核设计尚未实施，有六处设计缺口须在实施前修正（KS-09 至 KS-14）。

## 逐项核实与评估

"核实方式"一列说明执行者本人如何复核：源码核实，或平台源码核实（本机 engine 4.3.2 / driver 5.2.7）。

| 编号 | Codex 级别 | 问题 | 核实方式与结果 | 评估 |
| --- | --- | --- | --- | --- |
| KS-01 | P1 | 第一个遍历到的工人无论是否带能都占用防降级名额；带能的工人可能转去补能，无人升级；固定工人没有升级优先级 | 源码核实：`work` 中进入应急分支即清除 `info.emergency`（[fallback.ts](../../src/fallback.ts)） | **采纳，调为 P2**。应急阈值是 `CONTROLLER_DOWNGRADE` 的 25%（RCL3 约 5000 tick），名额每 tick 重新分配，不会立即降级；但 5.7 要求安排"具备有效 WORK 且有能量"的 creep，属于范围内修正 |
| KS-02 | P1 | 有 WORK、MOVE 但没有 CARRY 的矿工被计为可用采集者，从而阻止应急孵化，自身却完全不动作 | 源码核实：`canHarvest` 接受它，`work` 因无 CARRY 返回；固定分支因空余容量为 0 跳过采集。平台核实：engine `harvest.js` 第 43–54 行，无 CARRY 采集时超出容量的能量掉落，可正常产能 | **采纳，P1**。正常运营的静态矿工就是这种身体，保底接管后能量链与孵化会同时停止 |
| KS-03 | P2 | 真实 `FIND_MY_CREEPS` 排除孵化中的 creep，接替者判断永远不可达；替身返回全部 creep，测试因此假通过 | 平台核实：engine `game.js` 第 17 行 `!i.spawning && i.my` | **采纳，P2**。应从 `Game.creeps` 或 `spawn.spawning` 判断接替者，并修正替身 |
| KS-04 | P2 | 固定 creep 不读取也不更新当 tick 预留 | 源码核实：`stationary` 不接收 `TickState` | **采纳，调为 P3**。固定 creep 只操作相邻对象，重复提交只浪费少量 intent，不破坏闭环；仍应修正以满足 5.7 的预留约束 |
| KS-05 | P2 | 第一次 CPU 检查晚于全部房间的事实收集；同一类对象在多个阶段重复查询 | 源码核实：`collect` 在任何 `cpuOk` 之前对所有自有房间执行 | **采纳，P2**。退出余量是 5.7 的约束；engine 的 `find` 有当 tick 缓存，重复查询的主要成本是过滤分配，一并改为复用快照 |
| KS-06 | P2 | 房间级错误边界不完整：tower 枚举与 creep 枚举在 `guard` 之外，异常会逃出 `runFallback` | 源码核实：`towersOf(info.room)` 与 `room.find(FIND_MY_CREEPS)` 位于循环中，未包在 `guard` 内 | **采纳，P2** |
| KS-07 | P2 | 成本矩阵遗漏 source、mineral、controller 等非建筑障碍及己方阻挡类工地；替身寻路从不调用 `roomCallback`，矩阵逻辑未被测试 | 源码核实：`matrixFor` 只遍历 `FIND_STRUCTURES`；替身 `search` 不调用回调、`set` 不保存 | **采纳，P2**。原生 PathFinder 不认识房间对象，路径可能穿过 source 导致移动反复失败 |
| KS-08 | P2 | 真实 `spawnCreep` 即使不传 `memory`，也会写 `Memory.creeps[name]`；冷却期或装配失败时只运行保底，Memory 未被接管，会触发真实解析与写回 | 平台核实：engine `structures.js` 中 spawnCreep 在 dryRun 之后访问 `globals.Memory.creeps` | **采纳，P2**。这不是 fallback 直接访问 Memory；应由入口在运行保底前保证 Memory 已接管（经 kernel.memory 提供的接管能力），并在设计中写明 5.7"不读写"指保底代码自身的访问 |
| KS-09 | P2 | 空 Memory 时 `partitions`/`entities` 工厂本身就抛错，设计中"先构造上下文与 setup、再 boot"的顺序无法执行 | 源码核实：`createPartitions`、`entities` 入口首先调用 `state.check()`，数据未就绪即抛错 | **采纳，P2**。须定义 empty 阶段：boot 先判定并获授权初始化，ready 后再 setup 普通模块；empty 阶段跳过维护与提交 |
| KS-10 | P2 | boot 连续失败既不抛给入口，也不计入 degraded，不会触发保底 | 设计核实 | **采纳，P2**。把 boot 失败计入 degraded |
| KS-11 | P2 | setup 只运行一次，失败只计一次，无法累计到熔断，依赖者也没有暂停条件 | 设计核实 | **采纳，P2**。单独定义初始化失败状态及其依赖暂停、健康与恢复规则 |
| KS-12 | P2 | `recover` 重新 setup 会创建新的 spec 对象，与 Memory"同一身份只接受同一 spec"冲突 | 源码核实：`entities.ts` 第 65 行、`unit.ts` 第 97 行 | **采纳，P2**。普通熔断恢复只清除熔断状态，保留钩子与上下文；重新 setup 只随软重置发生 |
| KS-13 | P2 | 设计规定未知依赖或依赖环导致整个 `createKernel` 失败，与 contracts 第 2 节"拒绝启动该模块及依赖它的模块"冲突 | 文档核实：[contracts](../design/contracts/README.md) 第 63 行 | **采纳，P2**。沿用 contracts 的隔离规则 |
| KS-14 | P2 | errorMapper 设计称"各字段跨行累加"，但生成列在每个 `;` 处归零 | 规范核实：Source Map v3 中生成列按行重置，其余相对字段跨行延续 | **采纳，P2**。修正文档并加入跨行测试向量 |
| KS-15 | P2 | 测试辅助模块 JSDoc 不完整：`World.rooms.find` 类型签名、`creep`/`installWorld` 的对象参数未逐字段说明、房间 `find` 缺 `@param opts.filter` | 源码核实 | **采纳，调为 P3**。不影响运行，但违反 README 规则，合并前补齐 |

Codex 另指出两点，执行者同意：
- 测试"刚提交取能不连带升级"实际只验证了移动，未覆盖所声称的行为，须补强；
- `npx jest` 在其只读沙箱中因缓存目录不可写未能完整运行，其测试结论来自内存中的替代执行。执行者在工作区实际运行的结果是 12 个套件、194 项测试通过。

## 建议的整改方向

整改须经用户批准：

- **保底循环**（KS-01 至 KS-07）：
  - 防降级优先选带能、可升级的工人；
  - 无 CARRY 矿工照常采集，可用采集者判定与实际驱动一致；
  - 接替者改用 `Game.creeps` 或 `spawn.spawning` 判断；
  - 固定 creep 复用预留；
  - CPU 检查前移，并复用房间快照；
  - 补全房间级错误边界；
  - 成本矩阵加入非建筑障碍。
- **测试替身**：`FIND_MY_CREEPS` 排除孵化中的 creep；寻路替身调用 `roomCallback` 并保存矩阵；`spawnCreep` 替身模拟访问 `Memory.creeps`，以验证入口的接管前置条件。
- **内核设计**（KS-08 至 KS-14）：
  - 入口在运行保底前保证 Memory 已接管；
  - 定义 empty 启动阶段；
  - boot 失败计入 degraded；
  - 初始化失败状态；
  - recover 不重新 setup；
  - 清单校验按 contracts 隔离；
  - 修正 Source Map 解码描述。

  修订后的设计仍需用户确认后再实施。
- **JSDoc**（KS-15）：补齐测试辅助模块。

## 验证记录与限制

| 检查 | 结果 |
| --- | --- |
| Codex 运行的类型检查、边界检查与差异空白检查 | 通过（见其报告） |
| 执行者在工作区运行 `npm run check` | 通过：12 个套件、194 项测试，构建通过（审计前已运行） |
| 平台语义核实 | engine `game.js`（`FIND_MY_CREEPS`）、`structures.js`（spawnCreep 的 Memory 访问）、`processor/intents/creeps/harvest.js`（无 CARRY 采集掉落），均为公开源码阅读 |

Codex 的定向复现在其内存中完成，执行者没有逐一重放，而是以源码核实为准。未运行真实私服；CPU 成本只按调用路径判断，未作游戏内测量。

## 整改与复核记录（2026-10-19）

本节独立于以上审计记录。用户批准"按建议方向整改"。整改在 `feat/kernel-skeleton`、HEAD `c828728` 的未提交工作区进行；未修改 README、AGENTS、architecture，未提交、合并或部署。

### 逐项状态

| 编号 | 状态 | 整改内容 |
| --- | --- | --- |
| KS-01 | 已闭环 | 应急时每房每 tick 先选出升级者并最先处理：优先选带能且能立即升级的工人（可移动，或固定但已在范围内），取离控制器最近者；没有时选最近的可移动工人先去取能。固定工人是升级者时优先升级，不先补能 |
| KS-02 | 已闭环 | 有 WORK、MOVE 而没有 CARRY 的矿工前往 source 采集，能量落地；固定矿工采集不再要求空余容量。"可用采集者"判定与实际驱动一致 |
| KS-03 | 已闭环 | 接替者从各 spawn 的 `spawning.name` 到 `Game.creeps` 判断，带 WORK 才算；替身的 `FIND_MY_CREEPS` 改为排除孵化中的 creep |
| KS-04 | 已闭环 | 固定 creep 的转移与提取复用当 tick 预留，候选限定为相邻对象 |
| KS-05 | 已闭环 | 处理每个房间前先检查 CPU，包括收集事实之前。每房每 tick 只收集一次快照（creep、tower、spawn、建筑、障碍、补能目标、供给、source），防御、孵化、工作与矩阵各阶段复用 |
| KS-06 | 已闭环 | 收集、防御、孵化、工作四个阶段各有房间级错误边界，tower、creep 各有资产级错误边界；跨 creep 的筛选读取部件数失败按 0 处理，不中断整房 |
| KS-07 | 已闭环 | 成本矩阵加入 source、mineral、controller 与己方阻挡类工地（`OBSTACLE_OBJECT_TYPES`），均记为 255；替身寻路调用 `roomCallback` 并保存矩阵 |
| KS-08 | 设计已修订 | 保底代码自身不变。内核设计第 6 节规定入口每 tick 最先调用 kernel.memory 导出的 takeover，再做任何其他工作，冷却期与装配失败时同样适用；`beginTick` 识别同 tick 已完成的接管。保底设计写明 5.7"不读写"指保底代码自身，并说明 `spawnCreep` 对入口接管的依赖。替身 `spawnCreep` 按引擎语义访问 `Memory.creeps`，测试验证了两种情况：接管后写入落在临时对象上；未接管时孵化失败并被隔离 |
| KS-09 | 设计已修订 | 定义 empty 阶段：只运行 boot；普通模块的上下文与 setup 推迟到 Memory 首次为 ready 的 tick；empty 时跳过维护与提交。记录契约缺口：BootPort 需增加保留其他根键的 `initialize()`，在第 4 步提交确认 |
| KS-10 | 设计已修订 | boot 抛错的 tick 计为 degraded |
| KS-11 | 设计已修订 | setup 失败进入"初始化失败"状态，本 global 不重试，按熔断处理依赖暂停并计入健康状态，只能经软重置恢复 |
| KS-12 | 设计已修订 | `recover(id)` 只清除熔断状态与失败计数，保留钩子与上下文，不重新 setup |
| KS-13 | 设计已修订 | 清单校验按 contracts 隔离，只拒绝问题模块及其依赖者；只有选项本身不完整时 `createKernel` 才抛错 |
| KS-14 | 设计已修订 | 修正解码描述：生成列每行归零，其余相对字段跨行延续；验证清单加入跨行测试向量 |
| KS-15 | 已闭环 | 测试辅助模块补齐 JSDoc：`creep`、`installWorld` 的对象参数逐字段说明，房间 `find` 与矩阵方法独立注释；`fallback.test.ts` 的辅助函数同样补齐 |

KS-08 至 KS-14 为设计修订，尚无实现。修订后的内核设计需用户确认，实现时按这些规则补测试。

审计中还发现并修正了两处替身缺陷，它们曾导致假通过：
- 替身创建 spawn 时总把 `spawning` 覆盖为 null，原 KS-03 用例因此不能证明接替者判断；
- 替身 `spawnCreep` 不访问 Memory，掩盖了 KS-08。

### 回归测试

`test/fallback/fallback.test.ts` 由 18 项增至 30 项：
- KS-01：3 项（空载工人在前时名额仍给带能工人并最先处理、固定工人应急升级、刚提交取能不连带升级）；
- KS-02：3 项（无 CARRY 固定矿工、无 CARRY 移动矿工、它被计为采集者时不孵化）；
- KS-03：2 项（带 WORK 接替者不再孵化、无 WORK 时照常孵化）；
- KS-04：1 项（固定 creep 使用预留）；
- KS-05：2 项（CPU 到达上限时 find 次数为 0、find 次数不随 creep 数增长）；
- KS-06：2 项（房间查询抛错、tower 与 creep 资产抛错）；
- KS-07：1 项（矩阵内容与寻路选项）；
- KS-08：1 项（接管与未接管两种情况）。

原有用例中，孵化相关用例改为显式提供已接管的临时 Memory；"不访问 Memory"用例限定为保底代码自身。

### 反向验证

`src/fallback.ts` 先备份到任务临时目录；每次只撤销一处修复，运行 `test/fallback`，随后恢复，恢复后与备份逐字节一致。12 种撤销均使对应测试失败：

| 撤销内容 | 失败的测试 |
| --- | --- |
| 名额给第一个可移动工人 | KS-01 两项 |
| 升级者不先处理 | KS-01 空载在前 |
| 固定工人没有应急升级 | KS-01 固定工人 |
| 移动的无 CARRY 矿工不采集 | KS-02 移动矿工 |
| 固定矿工要求空余容量 | KS-02 固定矿工 |
| 不检查孵化中的接替者 | KS-03 正例 |
| 固定 creep 不用预留 | KS-04 |
| 收集房间前不查 CPU | KS-05 find 次数为 0 |
| 补能时重复查询 | KS-05 不随 creep 数增长。首轮反向验证未被发现，原因是测试中的工人都空载、未走补能路径；加强测试使补能、取能、采集都被覆盖后，重做撤销即失败 |
| 房间收集没有错误边界 | KS-06 房间查询 |
| tower 没有资产边界 | KS-06 资产 |
| 矩阵不含非建筑障碍 | KS-07 |

### 整体验证与剩余边界

- `npm run check`：类型检查通过；12 个套件、206 项测试通过；构建通过，没有上传。
- `git diff --check` 通过。
- 保底有效代码 253 行（上限 400）。
- JSDoc 扫描：新增文件除写在调用参数里的 `filter` 与 `roomCallback` 回调（规则豁免的内联回调）外全部符合。
- 整改后 SHA-256 前 12 位：

  | 文件 | 哈希 |
  | --- | --- |
  | `src/fallback.ts` | `4fe186e468eb` |
  | `test/fallback/world.ts` | `97702cfd7ec5` |
  | `test/fallback/fallback.test.ts` | `67fe1c64c3fa` |
  | `docs/design/fallback.md` | `1347ff368953` |
  | `docs/design/kernel/README.md` | `116eed7c6694` |
  | `docs/design/kernel/errorMapper.md` | `838f00a9d93a` |

- 所有结果来自游戏世界替身，真实行为待私服混沌测试（M1 第 7 步）复核；CPU 成本按调用次数判断，未作游戏内测量。
