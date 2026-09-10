# Leviathan Framework 设计

## 1. 模块定位与交付状态

`LeviathanFramework` 是项目的运行基座，负责生命周期、插件管理、Memory、异常隔离、性能观测、CPU 准入和基础意图仲裁。业务能力通过插件接入，Kernel 不包含物流、建造、防御等决策逻辑。

首版已经实现。创建实例后通过 `framework.loop` 提供游戏主循环，入口直接导出 `export const loop = framework.loop`。工厂与实例均使用闭包，不依赖 `this`。

当前装配路径：

```text
src/index.ts
  └── app/runtime.ts：创建 framework
        └── app/modules.ts：注册 roomShortcutsPlugin
              └── modules/roomShortcuts：服务实现
```

当前应用只装配 RoomShortcuts 服务；框架可运行，但尚未交付自动采集、物流、Spawn 或战争 AI。

## 2. 设计原则

- 使用工厂、显式上下文和小型组件组合，状态封装在 global 生命周期闭包内。
- 依赖关系单向：app 选择插件；Framework 调度插件；插件通过上下文访问基础设施。
- 同 tick 的三个阶段共用固定插件集合。管理变更在下一次 loop 开始时生效。
- 每个插件钩子和意图提交建立异常边界，错误映射与性能统计保持独立。
- 持久化状态保存 JSON；Game 对象和意图执行函数只保留在当前 tick。
- 需要返回值的操作使用服务接口，离散事实使用 EventBus，竞争性动作使用 IntentBroker。
- 高成本计算由插件分批执行；Framework 提供准入与剩余 CPU 查询，不提供抢占调度。

## 3. 核心组件与职责

| 组件                      | 实现位置                         | 职责                                               |
| ------------------------- | -------------------------------- | -------------------------------------------------- |
| Kernel / 生命周期         | `createFramework.ts`             | 驱动 loop、setup、三阶段、故障恢复和状态查询       |
| PluginRegistry            | `pluginRegistry.ts`              | 候选注册表校验、依赖排序、稳定快照                 |
| PluginContext             | `types.ts`、`createFramework.ts` | 注入 Runtime 风格上下文、服务、事件、Memory 与意图 |
| MemoryInterceptor         | `memoryInterceptor.ts`           | 常驻 heap、显式标脏、迁移与分层提交                |
| MemoryFragments           | `memoryFragments.ts`             | 原生 JSON 片段缓存、完整字符串组装与提交基线        |
| ErrorMapper               | `errorMapper.ts`                 | 同步堆栈还原及结构化异常捕获                       |
| CpuGovernor               | `cpuGovernor.ts`                 | 普通/关键插件准入和收尾预留                        |
| IntentBroker              | `intentBroker.ts`                | 通道与共享锁仲裁、提交、回执                       |
| EventBus / Profiler / Env | 现有 Core 组件                   | 强类型事件、嵌套 CPU 统计、Game 适配和日志         |

Kernel 与生命周期合并在工厂实现中，避免重复维护两套执行状态。现有 Runtime 上下文协议继续使用，Env 工厂供默认上下文复用，也允许注入 `createContext`。这些组件不为 Framework 另建重复实现。

## 4. 初始化与 tick 生命周期

### 4.1 创建与安装

`createFramework` 只创建 heap 容器和登记插件，不读取 Memory。首次 `loop` 开始时：

1. 将本轮管理命令应用到候选注册表。
2. 校验重复 id、缺失依赖、依赖环和服务冲突；全部成功才替换注册表。
3. 挂载 Memory，完成启用插件的安装或迁移。
4. 创建默认 Profiler，令其通过访问器读取当前 Memory 命名空间。
5. 按依赖顺序执行所有获准插件的 `setup`，随后才执行任何 `onTickBegin`。

这保证高层订阅者能在底层插件的 begin 事件发布前完成订阅。CPU 不足的插件推迟初始化。

`setup` 每个激活实例成功执行一次。global reset、重新注册、停用后重新启用都会产生新激活实例并重新 setup。安装/迁移由持久化版本号控制，不随 global reset 重复。

### 4.2 tickBegin

- 复用首次挂载后常驻 global heap 的 Memory 根，不再读取或解析 RawMemory。
- 根据启用状态、熔断状态、依赖可用性和 CPU 预算确定参与插件。
- 按拓扑顺序执行 `onTickBegin`。
- 上一轮提交回执通过 `context.intents.previous()` 提供。

世界事实核验、Event Log/Ruin 扫描与建筑事件发布由信息类服务插件放在此阶段。Kernel 提供顺序与回执，不内建游戏事件生产器。现有 RoomShortcuts 继续消费建筑事件，不能将“已有订阅”视为“事件生产器已实现”。

### 4.3 tickExecute

```text
onTickExecute（plan） → arbitrate → commit
```

先运行所有可用插件的执行钩子，收集意图；然后统一仲裁，最后调用胜者的执行函数。插件应通过 `context.intents.submit` 提交改变游戏状态的操作。

仅执行阶段允许提交意图。框架检查提交者身份和阶段；直接绕过接口调用 Game API 属于插件违反约定，首版不通过修改全局原型拦截所有 API。

发生 planner 异常时，已提交的该插件意图被拒绝。依赖失败也会阻止使用者执行和提交。其他独立插件继续运行。关键插件失败则终止后续提交并进入当前 tick 的安全模式。

### 4.4 tickEnd

所有已经进入 begin 的插件按逆序执行 `onTickEnd`，包括自身 begin 或 execute 失败的插件；从未进入 begin 的插件不会收到 end。

随后更新失败、熔断等关键健康状态，并把本 tick 意图回执留在 heap 供下一 tick 核验。MemoryInterceptor 只校验和序列化到期的 dirty 分区；没有持久变化时不调用 `RawMemory.set`。end 钩子异常不会阻断其他插件 end 或可执行的写回。

`OK` 或其他同步返回码只反映 API 提交情况；它们不证明世界变化已经完成。业务插件在下一 tick 对照 Game 状态核验事实。loop 若跳过了若干 tick，插件必须检查回执中的 `tick`，不能将旧回执视为紧邻上一 tick 的结果。

同一实例在同一 `Game.time` 重复调用 loop 不会重复执行，嵌套调用则拒绝。CPU 硬终止不保证 finally 执行，预留 CPU 只能降低风险，不能回滚游戏意图。

## 5. 插件协议与注册

公共类型以 [types.ts](../../src/core/framework/types.ts) 为准：

- manifest：`id/version/requires/optional/provides/priority/critical/persistence`。
- 生命周期：`setup/onTickBegin/onTickExecute/onTickEnd`。
- 数据迁移：`migrate(memory, fromVersion)`，返回目标版本的完整 JSON 数据。
- 清理注册：在 setup 调用 `context.onDispose(cleanup)`。

插件 id 必须是合法、唯一的字符串，不能使用对象原型保留键。version 为正整数。`requires` 缺失拒绝启动；`optional` 存在时参与排序，缺失时允许启动。

`persistence.layer` 可选 `critical`、`checkpoint`。只有 checkpoint 可以设置正整数 `checkpointInterval`。未声明 `persistence` 的插件不创建 Memory 分区；纯服务以及 RoomShortcuts、路径索引等可重建缓存由模块闭包管理。持久化层在同一插件实例的运行期不能改变；需要改变时应随代码发布触发 global reset。

持久化层的 `critical` 只表示 dirty 后当 tick 提交，与控制插件 CPU 准入和故障等级的 `manifest.critical` 相互独立。

稳定拓扑排序每轮从就绪节点中选择 priority 最高者，相同优先级按注册顺序决胜。所有声明服务的名称必须唯一，setup 结束前必须实际 provide。插件只能读取自身或声明依赖的插件提供的服务。

注册变更在边界使用候选 Map 原子验证。失败的命令批次丢弃，旧注册表保留；该 tick 不运行业务，下一 tick 可继续旧集合。移除不存在的插件安全忽略；启停未知插件会使该批次校验失败。

依赖停用、熔断或卸载时，使用者挂起。按逆序运行激活实例清理函数并移除服务，持久化数据保留。重新启用后从保留的 Memory 创建新实例。

### 5.1 上下文与缓存生命周期

Context 在 setup 时创建并缓存；`tick`、`persistence`、意图队列都在使用时读取当前值，避免每 tick 重复创建环境函数、日志器和服务门面。

跨 tick 可以持有 Context。持久插件只能通过 `context.persistence` 访问状态：`query()` 返回递归只读类型，`commit(callback)` 在执行回调前自动标脏，并把当前键值对象交给回调修改。未声明持久化的插件调用这两个方法会得到明确错误。实现不使用深层 Proxy，因此通过类型断言绕过只读结果直接修改会导致遗漏写回，属于插件违反协议。Game 对象仍然只能在当前 tick 使用。

### 5.2 事件订阅生命周期

`context.bus` 与 `context.events` 是同一个插件代理。订阅者名称自动增加插件 id 前缀，订阅限定在 setup；停用、卸载和 setup 失败后自动取消订阅。

回调通过 Framework 错误边界执行；不可用或本 tick 已失败的插件不会继续收到业务事件。插件手动注册的其他资源通过 `onDispose` 释放。清理函数应捕获需释放的句柄，不依赖新的服务查询。

## 6. IntentBroker 与资源竞争

公共意图字段：

```ts
interface GameIntent {
  subjectId: string;
  channel: string;
  priority?: number;
  locks?: readonly string[];
  execute(): ScreepsReturnCode;
  describe?: string;
}
```

pluginId 由 Context 注入，插件不能伪造其他提交者。提交时复制意图元数据，执行闭包仅保留一个 tick。

仲裁规则：

1. 按 priority 降序、提交序号升序处理候选。
2. 同一 `subjectId + channel` 互斥。
3. `locks` 是全局共享互斥键，可表达跨对象的资源预留。
4. 所有锁必须同时可用才选择胜者；失败不占用部分锁。
5. 全部候选选完后才开始 commit；胜者失败不重新启用落败候选。
6. commit 前再次检查提交插件与传递依赖是否仍可用。
7. CPU 收尾预算不足时推迟剩余提交，本 tick 闭包随队列丢弃。

`channel` 和 `locks` 是基础扩展协议，不包含完整的 Screeps 动作兼容矩阵或数量型资源账本。移动、治疗等不同动作能否同时执行，必须由业务层根据游戏规则分配通道和共享锁。

回执状态：

| status   | 含义                                               |
| -------- | -------------------------------------------------- |
| accepted | 胜出并完成 API 调用；读取 apiResult 判断同步返回码 |
| rejected | 冲突或提交插件/依赖不可用，未调用 API              |
| failed   | 执行函数抛异常                                     |
| deferred | 胜出但 CPU 不足，未调用 API                        |

每轮回执只在 heap 保留至下一 tick，不写入 RawMemory，也不累计无限历史。global reset 后插件直接依据 Game 世界事实恢复；确实需要跨 reset 保留的关键事务由业务插件写入自己的 critical 分区。

## 7. MemoryInterceptor

### 7.1 数据布局

```text
Memory.leviathan
├── schemaVersion: 1
├── framework
│   ├── pluginVersions
│   ├── pluginHealth
│   ├── intentReceipts
│   └── profiler
└── plugins
    └── <pluginId>: JSON 数据
```

原有 Memory 根的其他字段完整保留。默认实现通过 `RawMemory.get/set` 读写，并挂载 `globalThis.Memory`；测试可以注入 read/write/mount 存储端口。

主 schema 目前支持版本 1，未知或损坏版本进入安全模式且不覆盖原始数据。显式声明持久化的插件初次安装从版本 0 开始；没有 migrate 的新插件初始化为 `{}`。版本升级必须提供 migrate，降级拒绝。每次 migrate 负责将 fromVersion 转为 manifest.version，可在函数内部逐版本处理。

### 7.2 常驻 heap 与单次解析契约

每个 Framework 实例在首次 `loop` 挂载 Memory 时调用一次 `RawMemory.get()` 和 `JSON.parse()`。解析延迟到 loop 内执行，使无效 JSON 能被 Kernel 错误边界记录。成功后根对象常驻 global heap；后续 tick 不再调用 `RawMemory.get()`，也不比较原始字符串，更不会再次调用 `JSON.parse()`。global reset 会重建 Framework 实例，新实例再从最新 RawMemory 执行一次解析。

这一契约意味着实例存活期间以内存对象为唯一事实源。控制台或其他代码直接调用 `RawMemory.set()` 后，运行中实例不会接纳该字符串，下一次框架写回还可能覆盖它。需要让外部编辑生效时，应在编辑后触发 global reset。首次读取或解析失败也不会在同一实例内重复解析；修正原始数据后同样需要 global reset。

安装与升级不再创建递归 JSON 副本，迁移函数直接接收当前插件键值对象并返回新对象。迁移抛错时不会写回 RawMemory；如果迁移在抛错前原地修改了输入对象，该修改会留在当前 heap，内核不提供事务回滚。global reset 会重新读取最后成功提交的值。安装与升级强制在当 tick 提交，不受 checkpoint 间隔影响。

插件命名空间根必须是键值对象，内部内容由调用者负责，并完全采用原生 `JSON.stringify` 行为：例如对象属性中的函数和 undefined 会被省略、非有限数字会变为 null、循环引用会使 stringify 抛错。`commit` 在回调前标脏，因此回调抛错后仍保留保守的待提交状态。stringify 或写回失败不会清除 dirty，后续 tick 可以修复并重试，或通过 global reset 从最后成功持久化的数据恢复。

### 7.3 显式标脏与持久化层

显式声明持久化的插件拥有一个 `PersistenceNamespace`：

| 层 | 行为 | 适用数据 |
| --- | --- | --- |
| `critical` | dirty 后在当前 tickEnd 提交 | Spawn 队列、殖民任务、恢复所需状态 |
| `checkpoint` | dirty 后最迟在配置间隔到期时提交 | Profiler、历史统计等允许丢失近期变化的数据 |

checkpoint 的计时从首次标脏开始，后续连续更新不会向后移动期限。`checkpointInterval = 1` 表示当 tick 提交。global reset 最多丢失尚未到期的检查点变化，critical 分区在正常完成 tickEnd 时没有额外延迟。CPU 硬终止依然可能阻止任何层完成写回。

RoomShortcuts 不声明持久化，索引与校验租约由模块闭包维护。Goto 规划中的 CostMatrix、Flow Field、跨房路由场和避让状态也由模块闭包管理；只有用户定义的房间与边界偏好计划使用持久分区。Framework 不为这些缓存建立额外抽象或 Memory 条目。

### 7.4 分区序列化与完整字符串提交

首次解析后，MemoryInterceptor 为根级未知字段、Framework 核心字段、Profiler 和每个持久插件保存各自的 JSON 片段。flush 时 clean 分区直接复用旧片段；dirty 且到期的分区才执行原生 `JSON.stringify`。全部候选片段成功生成后，管理器拼装一份标准 JSON 字符串并调用 `RawMemory.set`；只有写入成功才替换片段并清除 dirty。

因此更新一个插件不会遍历或 stringify 其他插件的对象树，完全 clean 的 tick 不执行值序列化或 RawMemory 写入。由于 Screeps 的公开 API 只提供 `RawMemory.set(string)`，任何实际写入仍必须提交完整字符串；字符串拼装和传递的成本随最终文本长度增长，无法在默认 RawMemory 内执行字节级 patch。

Profiler 使用默认 100 tick 的检查点层，可通过 `profilerCheckpointInterval` 调整。意图回执只保留在 heap。插件成功执行次数不再每 tick 持久更新；失败计数、连续失败和熔断状态变化属于 Framework critical 状态。

Memory Segments 可以在未来提供真正的存储分区写入，但存在每 tick 最多激活 10 个且下一 tick 才可读取的调度约束；当前没有需要持久化的大型模块，因此本轮不引入空置的 segment 调度器。递归 Proxy 和 InterShardMemory 也不属于当前范围。

## 8. ErrorMapper、Profiler 与故障隔离

ErrorMapper 使用同步的 `@jridgewell/trace-mapping`，替代需要 Promise/WASM 初始化的 `source-map@0.8`。实现依据[解析库 API](https://github.com/jridgewell/sourcemaps/tree/main/packages/trace-mapping)，读取现有上传协议中的 `main.js.map` 模块。

解析器首次异常时懒加载；加载失败后本 global 生命周期内使用原始堆栈。V8 列号转换为 source map 的零基列后查询。非 main 帧保留不变。最多缓存 64 条、每条 16KB 的原始堆栈，防止重复错误无界增长。

捕获边界返回 `{ ok: true, value }` 或 `{ ok: false, failure }`。非 Error 抛出值也会规范化；字符串转换、映射和报告器再次失败时保留原始诊断，不击穿 loop。Promise 返回值被视为违反同步钩子契约并报告失败。

### 8.1 包装顺序与 CPU 归属

```text
ErrorBoundary.capture(metadata, callback)
  └── Profiler.wrap(pluginLabel, hook)
        └── 实际业务函数
```

业务异常先经过 Profiler finally 恢复调用栈和记录样本，再由外层边界捕获。堆栈映射和日志成本不计入出错插件，计入框架阶段及独立映射标签。

Profiler 的起始取样失败时直接执行原函数。结束时先恢复调用栈，再尝试取样和更新检查点分区；观测故障不会覆盖原始异常或返回值。每次统计修改前调用统一接口标脏，默认最迟 100 tick 提交。

所有包装器按固定 label 缓存，不在每 tick 重新 wrap。Profiler calls 包含成功和失败调用。插件健康只在失败、连续失败恢复或熔断变化时持久化；普通成功 tick 不再为了累计 successes 强制写入 Memory。

### 8.2 熔断与安全模式

默认连续失败 3 个参与 tick 后熔断插件，后续挂起使用者并释放实例资源。未参与的 tick 不重置连续失败计数。`recover(id)` 清除熔断状态，下一 tick 重试。

普通插件失败隔离于该插件；关键插件失败阻止后续业务提交。Memory、注册表或 Kernel 故障进入安全模式，尝试完成已经进入阶段的清理。safeMode 表示最近一次 loop 状态，每次新 loop 会重新判断。

安全模式只提供诊断与可执行的收尾；首版没有内建最低生存策略。

## 9. CPU 与性能观测

默认 `reserveCpu = 5`、`minBucket = 1000`：

- 普通插件要求 bucket 达标且当前 CPU 小于 limit 减去预留。
- critical 基础服务可使用 tickLimit 范围，但仍保留 reserveCpu。
- 意图提交使用 tickLimit 收尾边界。
- 所有已进入 begin 的插件仍尝试执行 end，插件必须控制收尾成本。
- CPU 不足时不抢占正在运行的函数，也不自动把当前执行闭包保存到下个 tick。

已提供固定 Profiler 标签：

```text
framework.tickBegin
framework.tickExecute.plan
framework.tickExecute.arbitrate
framework.tickExecute.commit
framework.tickEnd
plugin.<id>.setup / tickBegin / tickExecute / commit / tickEnd / dispose
framework.errorMapper.loadSourceMap
framework.errorMapper.mapStack
framework.errorMapper.report
```

Profiler 默认关闭，设置 enableProfiler 后采样。业务优先级应由后续策略层确定：生存、防御、Spawn 和关键物流优先，布局重算与远期规划可延期。

## 10. 首版验收与后续范围

已交付：

- 可直接导出的 loop、首次 setup 和三个 tick 阶段。
- 插件依赖校验、稳定排序、边界启停与资源清理。
- Runtime 风格上下文、服务注册表和 EventBus 集成。
- Memory 单实例一次解析、显式标脏、critical/checkpoint 分层、分区序列化和迁移。
- 同步 ErrorMapper、Profiler 加固与组合。
- CPU 准入、基础冲突通道、共享锁及提交回执。
- RoomShortcuts 服务插件与真实应用入口。
- 单元测试及真实 Rollup 产物的多 tick 沙箱运行和堆栈映射测试。

后续业务范围仍包括房间/跨房物流、资源管理、Spawn、自动布局、建造维护、防御战争、殖民资源房和交易模块。它们的具体决策与事实核验不包含在本次 Framework 交付中。

使用方式见 [Framework 使用说明](../usage/framework.md)。验证命令为类型检查、完整测试和不依赖密钥的构建；测试不会调用远端游戏上传 API。
