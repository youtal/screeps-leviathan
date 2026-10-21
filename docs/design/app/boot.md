# 模块设计：boot（启动判定）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/app/boot/` |
| 架构章节 | 6.7 项目标记、11.1–11.4 与 11.7–11.9 启动判定、5.6 boot 特权端口、13.4 告警 |
| 契约 | [contracts](../contracts/README.md#63-boot-特权端口与上下文) 第 6.3 节的 `BootDefinition`、`BootContext`、`BootPort`；`contracts/settings.ts` 的 `BootSettings`（第 8 节） |
| 成熟度 | 定稿 · M1：FRESH_START、RECOVERY、DORMANT、AMBIGUOUS 与 NORMAL。TAKEOVER、SELF_ADOPT 为 M2，SHARD_SEED、STRANDED 为 M5；M1 对这两组分支的处理见第 4.3 节 |

## 1. 职责

app.boot 在每 tick 的 boot 阶段最先运行：读取世界事实与原始 Memory 的概要，判定当前局面（`assess`），在闸门允许的范围内经特权端口执行不可逆操作（初始化、备份、清空、软重置），经 `setMode` 发布模式，并按 6.7 维护项目标记。它不理解业务，只决定"现在是什么局面、能否改动持久数据"。

判定是纯函数，执行与读取在外层，符合 12.1 的范式：

| 文件 | 内容 |
| --- | --- |
| `facts.ts` | 从 `Game` 读取本 tick 的事实，整理为纯数据 `BootFacts`；只由装配方注入的读取函数调用，测试中替换 |
| `assess.ts` | `assess(facts, input) → Verdict`：11.3 的 `memState`、11.4 的开局判定、11.7 的判定顺序；纯函数，不读 `Game`、不写任何状态 |
| `index.ts` | `createBoot(options): BootDefinition`：每 tick 的流程、闸门、执行、项目标记维护、控制台命令 |

## 2. 事实

```ts
interface BootFacts {
  readonly time: number;
  readonly spawns: readonly { id: string; room: string }[];
  readonly structCount: number;                // Game.structures 的数量（本方 OwnedStructure，含 controller）
  readonly nonCoreCount: number;               // 其中 spawn 与 controller 以外的数量
  readonly sites: number;                      // Game.constructionSites 的数量
  readonly creepCount: number;
  readonly pcHere: number;                     // 本 shard 中已生成的 PowerCreep 数
  readonly controllers: readonly { room: string; level: number; progress: number; safeMode: number | undefined }[];
}
```

- `controllers` 只取本方 controller，W 的判定与 safe mode 时钟由它与 `spawns` 得出。
- 事实只在需要完整判定的 tick 读取；平时只读第 5 节的廉价不变量。

## 3. Memory 状态

`memState` 由 `port.summary()` 与 Memory 能否加载得出（11.3）。能否加载以访问 `ctx.sys` 是否抛错判断（[bootPort](../kernel/bootPort.md#3-操作)"概要与加载"）。

| 概要 | 能否加载 | memState |
| --- | --- | --- |
| `parsed` 为 false | — | CORRUPT |
| `empty` 为 true | — | EMPTY |
| `marker` 为 null | — | FOREIGN |
| `marker.schema` 高于代码 | — | OURS_NEWER |
| `marker.schema` 等于代码 | 能 | OURS |
| `marker.schema` 等于或低于代码 | 不能 | UNLOADABLE（第 3.1 节） |

### 3.1 标记合法但无法加载（审计 SR-02）

标记合法而命名空间其余结构损坏，或标记的 schema 低于代码（M1 没有迁移）时，Memory 加载失败并锁存。11.3 没有对应的状态，按以下规则处置（2026-10-20 用户预先批准）：

- **W 成立**：按 CORRUPT 处理，走 11.4 的情形 b 或 b′。开局世界中旧数据没有保留价值。
- **W 不成立**：判为 AMBIGUOUS（中），通知人工，不清空。

## 4. 判定

### 4.1 判定顺序

按 11.7：

1. `memState` 为 OURS_NEWER → AMBIGUOUS（11.4 e）。
2. W 成立 → 11.4 的开局判定（第 4.2 节）。
3. S1 ∧ S2 成立 → 11.5，M1 见第 4.3 节。
4. `memState` 为 OURS → 资产相对 `fp` 大幅减少（房间数或 spawn 数少于 `fp` 的一半，或 spawn 数降为 0）时为 RECOVERY，否则 NORMAL。
5. T2 成立（有建筑或 creep）→ 11.6，M1 见第 4.3 节。
6. 否则 DORMANT。

UNLOADABLE 在第 2 步之前按第 3.1 节换成 CORRUPT（W 成立）或直接判为 AMBIGUOUS（W 不成立）。

### 4.2 开局（11.4）

W、safe mode 时钟、`placementTick` 与情形 a–e 完全按 11.4 计算，`T_FRESH` = 1500，`GAP` = 100（附录 B）。

| 情形 | 结论 | 执行（第 6 节） |
| --- | --- | --- |
| a：EMPTY | FRESH_START（强） | 初始化 |
| b：FOREIGN 或 CORRUPT，时钟可用 | FRESH_START（强） | 备份后清空 |
| b′：FOREIGN 或 CORRUPT，时钟不可用 | FRESH_START（中） | FOREIGN 且本项目命名空间缺失时初始化，外来键只读保留；通知人工，经 `boot.force('FRESH_START')` 确认后再清空。CORRUPT 无法初始化，判为 AMBIGUOUS 并通知 |
| c：OURS，`S.id ∉ fp.spawnIds`，`lastRun < placementTick` | FRESH_START（强，重生） | 备份后清空 |
| c′：同 c，时钟不可用，且 `S.id ∉ fp.spawnIds`、`r ∉ fp.rooms`、`time − lastRun > GAP` | FRESH_START（中） | 连续两次完整判定一致后，备份并清空 |
| d：OURS，`S.id ∈ fp.spawnIds` 或 `lastRun ≥ placementTick` | NORMAL | 无 |
| e：OURS_NEWER | AMBIGUOUS | 禁止清空 |

c′ 的其余条件不满足时（例如 `r ∈ fp.rooms`），证据不足以判为开局，判为 AMBIGUOUS（中）。项目标记的模式为 AMBIGUOUS 期间不写 `fp`，`lastRun` 照常写（第 7 节）：写入 `fp` 会把 S 记进指纹，之后世界回到开局状态时即落入 d 判为 NORMAL，未经确认就认领上一局的 Memory；`lastRun` 不能冻结，系统实际在运行，冻结会伪造"停运超过 `GAP`"的证据，使之后的判定改为 c′ 的开局并清空。这一条件随持久化的模式而定：世界暂时离开开局状态（判定落入"11.7 OURS 保持 AMBIGUOUS"）或经过 global reset，指纹同样不变。

### 4.3 M1 尚未交付的分支

S1 ∧ S2（跨 shard 新据点或滞留 creep，M5）与 T0 ∧ T2（Memory 丢失或外来、但有资产，M2 的接手）在 M1 都没有实现对象。M1 判为 AMBIGUOUS（中），证据中写明分支，通知人工，不清空。

AMBIGUOUS 要求"只运行生存层"，而 Memory 为 empty 时 kernel 连生存层也不运行。所以本项目命名空间缺失且能加载（EMPTY，或外来根键而无本项目命名空间）时，boot 初始化命名空间：只加入本项目的键、保留其他根键，不属于 11.8 的不可逆操作。CORRUPT 与 UNLOADABLE 无法初始化，kernel 计为 degraded，入口追加保底循环。

**AMBIGUOUS 保持到人工确认**：初始化后项目标记属于本系统，之后的完整判定会走 OURS 分支；若直接按资产判为 NORMAL，相当于未经确认就认领了来历不明的资产。所以 OURS 分支先读已持久化的模式：为 AMBIGUOUS 时继续判为 AMBIGUOUS（情形 `11.7 OURS 保持 AMBIGUOUS`），直到人工以 `boot.force` 指定模式。开局世界 W 的判定不受此限，重生（11.4 c）照常按强证据处理。

### 4.4 判定结果

```ts
interface Verdict {
  readonly mode: BootMode;
  readonly strength: Strength;
  readonly case: string;                // 例如 '11.4 b'、'11.7 RECOVERY'、'M1 T0∧T2'，用于连续判定的比较与日志
  readonly evidence: readonly string[]; // 人可读的证据，写入 sys.mode.evidence 与通知正文
  readonly action: 'none' | 'initialize' | 'clear';
}
```

## 5. 运行时机（11.1）

- **完整判定**：本 kernel 实例的第一个 tick；廉价不变量突变；tick 断档；人工 `boot.force` 或修改 `boot.dryRun` 之后的下一 tick（`boot.assess` 只观察，不触发）；进行中的备份或待确认的中证据（需要连续判定）。
- **廉价不变量**：spawn 数、`Game.structures` 数量、`Game.creeps` 数量、项目标记是否存在（Memory 是否 ready）。突变的定义：spawn 数变化；建筑数在 0 与非 0 之间变化或减少一半以上；creep 数在 0 与非 0 之间变化或减少一半以上；Memory 的 ready 状态变化。creep 数的日常增减不触发完整判定。
- **tick 断档**：本实例上次运行 boot 的 tick 不是当前 tick 减 1（架构 11.1）。没有对象的玩家不被调度（F6），同一 global 中的重生必然经过不运行代码的 tick；M1 部署后的稳态（1 个 spawn、2–4 个建筑、0 个 creep）重生后三个数量可能完全相同，只靠数量突变发现不了。bucket 耗尽而跳过的 tick 也会触发一次完整判定，成本可以接受。
- 读取三个数量各为一次 `Object.keys(...).length`，每 tick 的成本与对象数成正比，但不分配事实对象；tick 连续只比较一个 heap 中的整数。

## 6. 执行与闸门（11.8）

### 6.1 清空 Memory

前置条件全部满足才清空：

1. 证据：强证据一次，或中证据连续两次完整判定的 `case` 一致（heap 中的计数，global reset 后重新累计）；
2. 备份：`port.backup()` 返回 `done`；返回 `pending` 时本 tick 为暂停 tick，下一 tick 继续；返回 `failed` 时不清空，判为 AMBIGUOUS 并通知；
3. 配置：不在 `dryRun` 中；自动判定的清空还要求 `autoClear` 为 true（第 8 节）。`autoClear` 只约束自动清空：`boot.force('FRESH_START')` 本身就是人工确认，不受它约束，否则 `autoClear` 关闭时 b′ 的"经确认后再清空"只能改设置重新部署；
4. 顺序：本 kernel 实例的普通模块已 setup 时，先 `port.softReset()`，新实例重新判定后再备份与清空（11.4 附加规则 1，kernel 以前置条件强制）。

Memory 版本高于代码（OURS_NEWER，11.4 e）时禁止清空，人工指定 `FRESH_START` 也不例外：改判 AMBIGUOUS 并说明原因，不调用备份与清空。这种 Memory 通常来自回滚前的新版本，应由新版本按两步迁移处理（13.3）。

清空在同一 tick 依次执行 `clearMemory()`、`clearInterShard()`，再写入项目标记（第 7 节）。

清空尚待执行（中证据等待确认、软重置、备份进行中）时不写项目标记的任何字段，下一 tick 继续完整判定。重生的证据正是"spawn 不在指纹中、`lastRun` 早于放置"，若在新实例或下一次判定读到之前更新 `lastRun` 与 `fp`，判定会改为 NORMAL（附录 C 用例 15）。

清空被前置条件 2 或 3 拦下时，判为 AMBIGUOUS（中）并照常写入 `mode`。若 Memory 属于本系统（重生 c、c′ 或人工指定），冻结 `lastRun` 与 `fp`：照常维护会让之后的判定落入 11.4 d 判为 NORMAL，等于绕过 `autoClear` 认领上一局的 Memory。`release` 不是证据，照常写入。

冻结状态持久化在 `part.boot.control` 的 `frozen` 中（第 9 节），跨软重置与 global reset 保留，只在发布的模式不再是 AMBIGUOUS 时解除：人工以 `boot.force(mode)` 确认，或清空完成后生成新标记。中间的判定不解除冻结：世界暂时离开开局状态（判定落入第 4.3 节的"保持 AMBIGUOUS"）时，若恢复写入 `lastRun`，世界回到开局状态后 `lastRun` 不早于放置，判定即落入 d。冻结期间 `lastRun` 停止前进；世界回到开局状态而时钟不可用时可能落入 c′，再次尝试清空，这正是原判定的结论，仍受备份与 `autoClear` 的闸门约束。

### 6.2 其他操作

- **初始化**：`port.initialize()` 后在同一 tick 写入项目标记。不受 `autoClear` 约束，受 `dryRun` 约束。
- **dryRun**：只判定与发布模式，不调用 `initialize`、`backup`、`clearMemory`、`clearInterShard` 与 `softReset`，不写项目标记；证据中注明 dryRun。
- **通知**：模式或证据强度变化时调用 `Game.notify`（11.8），正文为模式、强度、情形与证据摘要；同一模式不重复通知。比较基准是本实例上次通知时的模式，首次通知时为执行动作之前持久化的模式；初始化与清空生成的标记带占位模式，不作为基准。清空尚待执行（中证据等待确认、软重置、备份进行中）时只发布、不通知，也不更新比较基准，结论由动作完成的那次发布通知一次：运行中途重生时，旧实例登记软重置后不通知，由新实例完成清空时通知。没有持久化的标记时（Memory 为空且无资产、Memory 损坏或无法加载、dryRun）没有比较基准，每个 kernel 实例首次发布时通知一次：这时没有可同步写入的持久存储，写主 Memory 会改变 `memState`，segment 在 global reset 的首个 tick 读不到。这些状态或基本不会运行（没有对象的玩家不被调度，F6），或是需要人工处理的持续故障，按 global reset 的频率重复提醒可以接受。

## 7. 项目标记维护（6.7）

| 字段 | 写入时机 |
| --- | --- |
| `lastRun` | Memory 为 ready 的每 tick |
| `release` | 每个 kernel 实例第一次 Memory 为 ready 时 |
| `fp` | 每 100 tick，以及完整判定之后 |
| `mode` | 每次完整判定之后，`since` 只在模式变化时更新 |
| `epoch`、`sig`、`schema`、`shard` | 由 bootPort 在初始化与清空时生成，boot 不写 |

- 模式为 RECOVERY 时不更新 `fp`：指纹保留损失前的资产，作为恢复的比较基准；资产恢复到指纹的一半以上后判为 NORMAL，再恢复更新。
- 模式为 AMBIGUOUS 时不更新 `fp`：资产归属尚未经人工确认，指纹保持最后一次确认时的内容（第 4.2 节）。
- `fp` 在每次完整判定之后更新，资产逐步减少时基准随之下调，RECOVERY 只识别相对上一次判定的大幅损失。
- 清空尚待执行时不写任何字段；本系统 Memory 的清空被闸门拦下后不写 `lastRun` 与 `fp`，直到冻结解除，`release` 照常写（第 6.1 节）。
- `lastRun` 每 tick 写入使 `sys` 每 tick 变脏，每 tick 编码一次项目标记（约 200 个字符）并拼接根文本。M2 起业务数据本来就几乎每 tick 变化，额外成本只有标记的编码。
- `fp.rooms` 为本方 controller 所在的房间名，`fp.spawnIds` 为本方 spawn 的 id，`fp.creepCount` 为 creep 数。

## 8. 设置与控制台（11.9）

使用者设置（`src/settings.ts`，类型在 `contracts/settings.ts`）：

```ts
interface BootSettings {
  readonly autoClear: boolean;   // 11.8 的 boot.autoClear：是否允许自动判定的清空；默认 true（2026-10-20 用户预先批准）
  readonly dryRun: boolean;      // 部署到新环境前先设为 true，观察判定结果；默认 false
}
```

控制台（命名空间 `boot`）：

| 命令 | 作用 |
| --- | --- |
| `boot.assess()` | 读取当前事实完整判定一次，返回模式、强度、情形与证据，不执行、不发布 |
| `boot.force(mode)` | 人工指定模式（强证据），只作用于下一 tick 的完整判定：发布该模式并按第 6 节执行（不受 `autoClear` 约束，OURS_NEWER 时仍禁止清空），之后清除，恢复自动判定。清空尚待执行时保留到清空完成（可能在软重置后的新实例中）；dryRun 期间不消耗。所以 AMBIGUOUS 的确认一步完成，不需要再取消；`boot.force()` 取消尚未生效的指定。指定保存在 boot 的分区 `part.boot.control` 中，被采用之前跨 global reset 保留；Memory 不可用时只在 heap 中保留。读回的值不是合法模式时（手工编辑）按没有指定处理，清除并告警 |
| `boot.dryRun` | 读写设置，覆盖 `BootSettings.dryRun`，只存于 heap；修改后下一 tick 重新完整判定，关闭时随即按第 6 节执行判定的动作。软重置与 global reset 后回到设置中的值 |

## 9. 装配

app.assembly 以 `createBoot({ identity, release, settings, time, facts, counts, notify })` 创建 boot 定义：`identity` 为 Memory 身份（命名空间判断能否初始化，schema 用于 11.3 的比较），`release` 为构建注入的版本号，`settings` 为 `bootSettings`，`time` 为当前 tick，`facts` 与 `counts` 分别读取第 2 节的事实与第 5 节的廉价不变量（游戏实现为 `readGameFacts`、`readGameCounts`），`notify` 调用 `Game.notify`。

`part.boot.control` 在 Memory 首次就绪时申请，与 kernel 的启停标志分区一样，是已初始化存储运行后新增的内容。版本 2 的数据为 `{force, frozen}`，初始为 `{force: null, frozen: false}`；版本 1 只有 `force`，迁移时保留合法的指定并补 `frozen: false`，读到其他版本时回到初始数据。

## 10. 已确认的决定（2026-10-21）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| Q1 | M1 对 S1 ∧ S2 与 T0 ∧ T2 的处理 | 第 4.3 节：AMBIGUOUS（中）并通知，不清空；本项目命名空间缺失且能加载时初始化，并保持 AMBIGUOUS 到人工确认 |
| Q2 | "AMBIGUOUS 只运行生存层"由谁执行 | 由 kernel.cpu 在准入时按模式排除非生存层，在 M2 第一个非生存层模块交付前补入 cpu 设计；M1 没有非生存层模块，本步不改 kernel |
| Q3 | 契约 `BootSettings` | 第 8 节，加入 `contracts/settings.ts` |
| Q4 | `boot.force` 的保存位置 | boot 分区 `part.boot.control`，跨 global reset 保留 |
| Q5 | 开局时的词库提示 | 推迟到 M2，与词库一并实现 |

## 11. 验证

- **单元测试**：附录 C 用例 1–6、14–16 按原期望；用例 7–13 在 M1 按第 4.3 节期望 AMBIGUOUS；第 3.1 节的两种情形；闸门的每个前置条件（中证据一次不清空、备份 pending 与 failed、`autoClear` 关闭、dryRun、已 setup 时先软重置）；本系统 Memory 的清空被拦下后冻结 `lastRun` 与 `fp`、重建后仍判为 AMBIGUOUS，世界暂时离开开局状态与重建后冻结仍在，人工确认后解除；tick 断档触发完整判定，M1 稳态下数量不变的重生登记软重置；人工指定只采用一次，读回的非法值按没有指定处理；c′ 判为 AMBIGUOUS 后不写 `fp`、`lastRun` 照常前进，重建后及世界离开又回到开局状态后仍为 AMBIGUOUS；冻结期间照常写 `release`；关闭 dryRun 后下一 tick 重新判定且不覆盖重生证据；OURS_NEWER 时人工指定不清空，`autoClear` 关闭时人工确认仍可清空；廉价不变量的突变阈值；项目标记各字段的写入时机；模式变化的通知只发一次，运行中途重生经软重置时也只发一次；控制台命令。
- **私服场景**（bootPort 设计第 7 节、13.2）：
  - kernel-smoke：放置 spawn 后判为 FRESH_START 并初始化（M1 验收标准第 1 条）；已初始化存储在证据不足时判为 AMBIGUOUS、不清空；
  - boot-judgment：外来 Memory 的开局判为 b′ 并初始化，经 `boot.force('FRESH_START')` 确认后软重置、备份、回读并清空；有资产而 Memory 为空时判为 AMBIGUOUS 并初始化；
  - memory-takeover：判定后孵化 creep 触发完整判定，保持 AMBIGUOUS。
