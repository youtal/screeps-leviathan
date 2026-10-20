# 模块设计：内核骨架

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/kernel/lifecycle/`、`src/kernel/process/`、`src/kernel/context/`、`src/kernel/logger/`，以及入口 `src/main.ts`、装配 `src/app/assembly/` |
| 架构章节 | 4.4 运行模型、5.1 进程表、5.4 上下文、5.5 启停与软重置、5.7 保底循环、5.8 可观测性；契约见 [contracts](../contracts/README.md) |
| 成熟度 | 定稿 · M1 |

本文是 kernel 层内跨模块的设计：宿主接口、tick 流水线、进程表、上下文派生与日志。错误映射见 [errorMapper](./errorMapper.md)，Memory 见 [memory](./memory.md)，segment 见 [segments](./segments.md)，boot 特权端口见 [bootPort](./bootPort.md)，InterShardMemory 见 [intershard](./intershard.md)。cpu、stats、console 在后续步骤交付，本文只规定它们交付前的临时行为。

## 1. 宿主接口

kernel 只通过 `createKernel` 暴露给装配方（`app.assembly`）与入口（`main.ts`），业务模块看不到它。

```ts
interface GamePort {                     // 当 tick 的游戏事实，由装配从 Game 读取；测试中替换
  time(): number;
  cpuUsed(): number;
  tickLimit(): number;
  limit(): number;                       // Game.cpu.limit，用于计算收尾预留
  bucket(): number;
  shard(): string;                       // 身份用的 shard 名（11.3 的 here）：有 InterShardMemory 时为 Game.shard.name，否则为 'x'（F7）
  creepNames(): ReadonlySet<string>;     // 含孵化中的 creep
  flagNames(): ReadonlySet<string>;
}

interface KernelOptions {
  readonly modules: readonly ModuleDefinition[];
  readonly boot: BootDefinition;
  readonly memory: MemoryOptions;        // kernel.memory 的配置，实例由 kernel 创建并管理
  readonly game: GamePort;
  readonly logRoot: LogRoot;             // 日志根对象，由装配方按 settings.ts 的 loggerSettings 创建，错误格式化接 errorMapper
  readonly profiler: Profiler;           // 计时聚合器
  readonly profileInstances?: boolean;   // 是否对实例钩子单独计时，默认 false
  readonly release: string;              // 构建时注入的版本号，写入新建的项目标记
  readonly segments: SegmentsPlatformPort; // kernel.segments 的平台端口（segments 设计第 4 节）
  readonly interShard: object;           // InterShardMemory 所在的全局对象，游戏中为 globalThis
}

type KernelHealth = 'ok' | 'degraded' | 'paused';   // paused 见第 2 节"暂停 tick"

interface Kernel {
  tick(): KernelHealth;                  // 执行一个完整 tick
  resetRequested(): boolean;             // boot 本 tick 登记了软重置；入口据此在下一 tick 前重建
  dispose(): void;                       // 撤销全部能力，供软重置与入口重建使用
}
```

- `createKernel` 只校验选项与清单、分配状态，不读取游戏对象；Memory 实例在此创建，首个 `tick` 才加载，Memory 就绪后才对各模块调用 `setup`。
- 日志根对象与计时器由装配方创建后传入：logger 的默认开关来自 `src/settings.ts`，而 kernel 不导入设置文件（架构 4.3）。
- 依赖全部显式注入（架构 4.2）：kernel 不读全局 `Game`，测试以假 `GamePort` 驱动。

## 2. tick 流水线

```text
tick()
  1. memory.beginTick(facts)           任何 Memory 访问之前；facts 来自 GamePort；结果为 empty 或 ready
     segments.beginTick()              读取上一 tick 激活的页并删除这些键（与 Memory 状态无关）
  2. boot                              boot.boot()，独立错误边界；empty 时 boot 决定是否经特权端口初始化
  3. 普通模块 setup                    Memory 首次为 ready 且不是暂停 tick 时执行一次（见下）
  4. sense → plan → arbitrate → act → move
                                       仅 Memory 为 ready 且不是暂停 tick 时运行；按进程顺序调用钩子，每次调用独立错误边界
  5. commit                            Memory 为 ready 时执行 maintain() 与 commit()；empty 时跳过；
                                       之后 segments.commit()（每 tick，与 Memory 状态无关）
  返回 health
```

- **暂停 tick**：boot 在本 tick 调用 `port.backup()` 且得到 `pending`，或调用了 `port.softReset()`，本 tick 即为暂停 tick。
  - 跳过普通模块 setup 与全部业务阶段，commit 阶段照常执行，boot 经 `sys` 的写入与备份页的写出都在本 tick 提交；
  - `tick()` 返回 `paused`，不计为 degraded（包括 Memory 加载失败），入口按第 6 节的上限处理；
  - 理由：备份至少跨两个 tick（写出、下一 tick 回读），而 11.8 要求备份完成后才能清空。若备份期间普通模块已经 setup，`clearMemory()` 的前置条件就无法满足；若业务模块或保底循环在判定与清空之间孵化或放置工地，下一 tick 的开局世界 W 不再成立，判定无法重现（11.4 附加规则 3）。

- **empty 阶段**：Memory 的分区与实体工厂在数据就绪前会抛错，所以 empty 时只运行 boot。
  - boot 的上下文在首个 tick 创建，其中 `sys` 与 `port` 惰性取用；
  - 普通模块的上下文与 `setup` 推迟到 Memory 首次为 ready 且不是暂停 tick 的 tick，在 boot 之后、各阶段之前执行；
  - empty 期间不调用 `maintain` 与 `commit`；boot 在本 tick 完成初始化后，Memory 即为 ready，本 tick 照常提交。
  - 初始化经 `BootPort.initialize()` 加入本项目命名空间、保留其他根键（11.4 a 与 b′）；清空经 `clearMemory()`，只能在本 kernel 实例的普通模块 setup 之前执行，否则须先软重置（[bootPort](./bootPort.md)）。
- **boot 失败**：boot 钩子抛错时记录错误，本 tick 跳过 setup 与全部业务钩子，ready 时仍执行 commit。boot 是启动判定的唯一来源，判定失败时不能让业务模块按过期模式运行。boot 失败的 tick 计为 degraded（第 6 节）；本 tick 登记的软重置作废，kernel 实例保留，下一 tick 重新判定（[bootPort](./bootPort.md#3-操作)）。
- **setup 失败**：模块进入"初始化失败"状态，本 global 内不再重试。重新 setup 会再次创建分区与切片的 spec 对象，而 Memory 对同一身份只接受同一 spec（[memory](./memory.md)）。初始化失败的模块按熔断处理依赖暂停（3.3），只能经软重置或新的 global 恢复。
- **commit 失败**：记录错误；Memory 自身保留脏状态，下一 tick 重试（[memory](./memory.md)）。
- **维护准入**：cpu 模块交付前，每 tick 以默认上限调用一次 `maintain`；交付后改由维护层准入控制。

## 3. 进程表

### 3.1 静态模块排序

启动时对清单做一次稳定拓扑排序：在所有依赖已排好的模块中，按"层级 → priority → id"选出下一个。

清单校验按 contracts 第 2 节隔离：只拒绝有问题的模块及经 `requires` 依赖它的模块，记录原因，其余模块照常启动。被拒绝的模块按"初始化失败"计入健康状态。拒绝条件：
- id 为空、为保留名（`boot` 是启动判定上下文的 owner，`core` 是实体空间公共切片的 owner），或与其他模块重复（重复的各方都拒绝）；
- `requires` 或 `optional` 指向未知模块；
- 处在依赖环上；
- `requires` 了层级更低的模块。例如生存层模块依赖经济层模块：经济层可能不被准入，而生存层总是运行，两者矛盾。`optional` 不受此限。

只有选项本身不完整（例如缺少 boot 或 Memory 配置）时，`createKernel` 才抛错。

### 3.2 动态实例

模块经 `ctx.processes.add/remove` 增删实例。进程键为 `<模块 ID>:<实例键>`。

每个阶段中，模块自身的钩子先执行，随后按添加顺序执行它的实例的同名钩子。实例继承模块的层级与位置。新增的实例从下一个阶段开始参与调度，删除立即生效（调用 `dispose`）。

### 3.3 错误边界与熔断

- 每次阶段钩子调用都在 try/catch 中。抛错使该进程的连续失败计数加 1，任一调用成功则归零。setup 与 dispose 也在 try/catch 中，但 setup 失败直接进入"初始化失败"（第 2 节），不参与计数。
- 计数达到熔断阈值（附录 B：连续 3 次）时进程熔断，不再调用其钩子，只记录一次熔断日志。
- 静态模块熔断或初始化失败时，它的全部实例，以及经 `requires` 直接或间接依赖它的模块，一同暂停。每个阶段访问模块时重新判断能否运行，依赖在某个阶段熔断后，依赖它的模块从同一阶段起即暂停。
- 实例熔断只影响该实例。
- 运维命令 `recover(id)`（第 5 步随 console 交付）只清除熔断状态与失败计数，保留原有钩子与上下文，不重新 setup，与 Memory 的 spec 身份规则一致。初始化失败的模块不能就地恢复，须经软重置。
- 启停标志（5.5）随 console 与 ops 在第 5 步交付；在此之前，所有未熔断的进程都运行。

## 4. 上下文

kernel.context 为每个模块派生一个 `ModuleContext`，在整个 global 生命周期内稳定：

| 字段 | 来源 |
| --- | --- |
| `log` | 作用域为模块 ID 的 Logger |
| `memory`、`rooms`、`creeps`、`flags` | `memory.partitions(id)` 与 `memory.entities(id)`；上下文在 Memory 首次为 ready 时创建，因此取用时数据已就绪 |
| `mode` | boot 通过 `setMode` 发布的只读视图；尚未发布时为 `AMBIGUOUS`/`medium` |
| `processes` | 本模块的实例表 |
| `measure`、`cpu` | 见下 |

- `instance(key)` 惰性派生并缓存 `InstanceContext`，日志作用域为进程键。
- `onDispose` 登记的函数在软重置或入口重建时按登记顺序调用，各自独立错误边界。
- **cpu 与 profiler 交付前的临时行为**：
  - `measure.begin()` 返回 `GamePort.cpuUsed()`，`end` 不做聚合；
  - `cpu.remaining()` 为 `tickLimit − cpuUsed − 收尾预留`，`shouldYield()` 在剩余不足收尾预留时为 true。

  第 5 步以分层准入与预算替换，契约不变。
- **BootContext**：在首个 tick 创建，在 ModuleContext 之外提供 `sys`、`setMode` 与 `port`。`memory`、`rooms`、`creeps`、`flags` 与 `sys` 惰性取用，Memory 为 empty 或加载失败时访问会抛错；加载失败时概要中仍可能有合法的项目标记，boot 以访问 `sys` 抛错识别这种情形（[bootPort](./bootPort.md#3-操作)"概要与加载"）。`port` 只在 boot 钩子运行期间有效，其他时候调用即抛错（[bootPort](./bootPort.md)）。

## 5. 日志

- 输出格式：`[<tick>] <级别> <作用域>: <正文>`，经 `LogSink` 输出。
- **级别**：debug、info、success（游戏内关键状态转移成功）、warn、error。
- **双层开关**：第一层是日志根对象的默认值，`createLogRoot` 的 `levels` 必须为每个级别给出，缺一即报错；默认值由装配方从 `src/settings.ts` 的 `loggerSettings` 读取后注入，可由 `setDefault` 修改（供运维命令使用）。第二层是作用域覆盖值，业务模块经 `ctx.log.configLevel({ [级别]: 开关 })` 一次设置一个或多个级别，值为 `undefined` 时恢复默认。实例作用域以所属模块作用域为父，继承其覆盖值。级别关闭时，函数形式的正文不求值。
- **上色**：官服的 `console.log` 会把输出整体转成 HTML 实体，标签显示为原文；`console.logUnsafe` 原样下发，由客户端按 HTML 渲染。装配方存在 `logUnsafe` 时以它为输出端并按使用者设置开启上色，不存在时以 `console.log` 为输出端且不上色。上色时前缀 `[<tick>] <级别>` 按级别着色（debug 天青、info 灰、success 绿、warn 橙、error 红），同时转义作用域与正文中的 `&`、`<`、`>`，否则堆栈里的 `<anonymous>` 等文本会被当成标签吞掉；正文中的换行改为 `<br>`，否则多行堆栈会被折叠成一行。不开启时输出纯文本，供测试与不渲染 HTML 的使用方。
- `error` 附带经 `ErrorMapper` 规范化的堆栈。映射受 CPU 保护，规则见 [errorMapper](./errorMapper.md)。
- 同一进程连续失败时最多记录到熔断为止，熔断后只记一次熔断日志，避免刷屏。

## 6. 入口：正常循环与保底循环

`main.ts` 在 heap 中持有 kernel 实例与故障计数，每 tick：

```text
先接管全局 Memory（kernel.memory 导出的 takeover，与实例无关、不解析文本、同 tick 幂等）
若处于停用冷却期：只运行保底循环，冷却到期后重新装配
否则：
  try   kernel ??= assemble(); health = kernel.tick()
  catch 记录映射后的错误；kernel.dispose()（异常隔离）；kernel = undefined，下一 tick 重新装配
        连续失败计数 +1，达到上限则进入停用冷却
  health 为 paused：连续暂停计数 +1；未超过 PAUSE_LIMIT 时 degraded 计数不变，超过后按 degraded 计数
  health 为 ok 或 degraded：连续暂停计数清零
  tick 正常结束：连续暂停未超过 PAUSE_LIMIT 时，连续失败计数清零；超过时保持
  tick 正常结束且 kernel.resetRequested()：kernel.dispose()，kernel = undefined，下一 tick 重新装配（软重置）；
        连续暂停未超过 PAUSE_LIMIT 时不计入失败，超过时连续失败计数 +1，达到上限同样进入停用冷却
  抛错，或连续 SAFE_MODE_TICKS 个 tick 计为 degraded → 本 tick 运行保底循环
```

架构 5.7 中"连续 N tick 进入安全模式"的定义：

| 名称 | 含义 | 默认值 |
| --- | --- | --- |
| 安全模式（degraded） | 满足任一条件：本 tick boot 抛错；生存层的任一静态模块已熔断、初始化失败或因依赖暂停；Memory 实例加载失败，所有模块都无法读写持久数据 | — |
| 暂停（paused） | boot 本 tick 的备份尚未完成或登记了软重置（第 2 节）；不运行业务阶段，也不计为 degraded | — |
| `SAFE_MODE_TICKS`（即 N） | 连续处于 degraded 的 tick 数达到此值后，每 tick 在正常循环之后追加运行保底循环，直到恢复 | 3 |
| `PAUSE_LIMIT` | 连续暂停的 tick 数上限，跨软重置累计；超过后暂停 tick 计为 degraded，保底循环得以接管。备份一次重写加软重置最多约 7 tick | 10 |
| `KERNEL_CRASH_LIMIT` | 连续失败的次数上限；失败指 kernel 抛出可捕获异常，或连续暂停超过 `PAUSE_LIMIT` 后 boot 仍登记软重置。达到后停用正常循环 | 3 |
| `KERNEL_COOLDOWN` | 停用冷却期：触发停用的那个 tick 之后的这么多个 tick 只运行保底循环，之后重新装配 | 100 tick |

- **先接管 Memory**：引擎的 `spawnCreep` 即使不传 `memory` 选项也会访问 `Memory.creeps`，保底循环也会孵化。装配可能失败，冷却期也不装配 kernel，所以入口在任何其他工作之前先完成接管，使这类引擎内部写入只落在临时对象上，不触发真实 Memory 的解析与写回。takeover 由 kernel.memory 提供，入口不直接操作全局 Memory（架构 4.2 的持久化边界）；Memory 实例的 `beginTick` 识别同 tick 已完成的接管，不视为接管过晚。这需要对已合并的 Memory 模块做一处配套修改，随内核实现一并交付。
- **抛错后重建**：异常可能使 kernel 内部状态不一致，所以抛错后丢弃实例，下一 tick 重新装配；Memory 从 RawMemory 重新加载，未提交的 heap 修改随之丢弃。
- **软重置**：boot 经 `port.softReset()` 登记后，本 tick 为暂停 tick，跳过业务阶段但照常提交；入口销毁实例，下一 tick 重新装配。全部进程实例与模块级 heap 缓存随旧实例丢弃，Memory 从已提交的文本重新加载，效果等同于一次 global reset（5.5）。
- **冷却期**：持续抛错时每 tick 重新装配会反复解析 Memory。冷却期把这项成本限制在每 100 tick 一次。
- **重置循环**：boot 的缺陷可能使每个新实例都再次登记软重置，效果与持续抛错相同。正常开局流程的暂停不超过 `PAUSE_LIMIT`，所以超限后的软重置按失败计数，与抛错共用冷却。超限期间暂停 tick 不清零失败计数，软重置与普通暂停交替时同样受限。boot 抛错的 tick 计为 degraded 而不是 paused，不受上述计数约束，所以这样的 tick 登记的软重置由 kernel 作废（第 2 节"boot 失败"），不触发重建。
- **重复提交**：正常循环部分执行后才转入保底时，同一 tick 可能已经提交过 intent。保底按 5.7 的约束不重复提交同一动作，但不保证避免与正常循环的动作冲突。
- **CPU 硬终止**无法被 catch 接管（5.7）。计数只统计可捕获的异常。

## 7. 装配（第 2 步的临时内容）

`app.assembly` 提供：
- 模块清单：第 2 步为空，业务模块从 M2 开始加入；
- Memory 配置：命名空间、签名、schema，取自 `app.config`；
- 构建注入的版本号（`virtual:release`，[bootPort](./bootPort.md) 第 6 节）、segment 平台端口与 InterShardMemory 所在的全局对象；同一版本号在第 6 步也传给 app.boot，供其更新 `sys.release`；
- `GamePort`、`LogSink`、`ErrorMapper` 的游戏实现；`LogSink` 按第 5 节在 `console.logUnsafe` 与 `console.log` 之间选择；日志根对象的各级别默认开关与上色开关取自 `src/settings.ts` 的 `loggerSettings`；
- **临时 boot**：只发布 `AMBIGUOUS`/`medium`，不执行任何不可逆操作，也不初始化 Memory；在第 6 步由 `app.boot` 替换。在此之前，空存储保持 empty，普通模块不会 setup，也不运行业务钩子（第 2 节）。
