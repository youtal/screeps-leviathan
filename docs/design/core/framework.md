# Leviathan Framework 设计

交付状态：Framework 协议、Runtime 消费、MemoryHost 生命周期驱动与插件事务已交付。

## 1. 模块定位

`LeviathanFramework` 是项目的运行基座，负责生命周期、插件管理、异常隔离、性能观测、CPU 准入和基础意图仲裁。业务能力通过插件接入，Kernel 不包含物流、建造、防御等决策逻辑。

创建实例后通过 `framework.loop` 提供游戏主循环，入口直接导出 `export const loop = framework.loop`。工厂与实例均使用闭包，不依赖 `this`。

## 2. 设计原则

- 使用工厂、显式上下文和小型组件组合，状态封装在 global 生命周期闭包内。
- 依赖关系单向：app 选择插件；Framework 调度插件；插件通过上下文访问基础设施。
- 同 tick 的三个阶段共用固定插件集合。管理变更在下一次 loop 开始时生效。
- 每个插件钩子和意图提交建立异常边界，错误映射与性能统计保持独立。
- 持久化状态保存 JSON；Game 对象和意图执行函数只保留在当前 tick。
- 需要返回值的操作使用服务接口，离散事实使用 EventBus，竞争性动作使用 IntentBroker。
- 高成本计算由插件分批执行；Framework 提供准入与剩余 CPU 查询，不提供抢占调度。

## 3. 核心组件与职责

| 组件                      | 建议职责位置                         | 职责                                               |
| ------------------------- | -------------------------------- | -------------------------------------------------- |
| Kernel / 生命周期         | `createFramework.ts`             | 驱动 loop、setup、三阶段、故障恢复和状态查询       |
| PluginRegistry            | `pluginRegistry.ts`              | 候选注册表校验、依赖排序、稳定快照                 |
| PluginContext             | `contracts/plugin.ts`、`createFramework.ts` | 注入 Runtime 风格上下文、服务、事件、意图与 Memory 申请入口 |
| ErrorMapper               | `core/errorMapper`               | 由 Runtime 提供的同步堆栈还原及结构化异常捕获      |
| CpuGovernor               | `cpuGovernor.ts`                 | 普通/关键插件准入和收尾预留                        |
| IntentBroker              | `intentBroker.ts`                | 通道与共享锁仲裁、提交、回执                       |
| EventBus / Profiler / Env | Core 能力                   | 强类型事件、嵌套 CPU 统计、Game 适配；日志由 Runtime 的 LoggerFactory 注入 |

Kernel 与生命周期合并在工厂实现中，避免重复维护两套执行状态。Framework 必须接收完整 `CoreRuntime`，并消费其中的上下文工厂、EventBus、Profiler、ErrorMapper 与 MemoryHost；Framework 不导入或创建这些同级 Core 能力的具体实现。

## 4. 初始化与 tick 生命周期

### 4.1 创建与安装

`createFramework` 只创建 heap 容器和登记插件，不读取 Memory。首次 `loop` 开始时：

1. 将本轮管理命令应用到候选注册表。
2. 校验重复 id、缺失依赖、依赖环和服务冲突；全部成功才替换注册表。
3. 创建默认 Profiler，令其访问实例内的 heap 统计容器。
4. 按依赖顺序执行所有获准插件的 `setup`，随后才执行任何 `onTickBegin`。

这保证高层订阅者能在底层插件的 begin 事件发布前完成订阅。CPU 不足的插件推迟初始化。

`setup` 每个激活实例成功执行一次。global reset、重新注册、停用后重新启用都会产生新激活实例并重新 setup。所有 heap 状态在 global reset 后重建。

### 4.2 tickBegin

- 复用实例内的健康表、上下文与统计缓存，不访问 RawMemory。
- 根据启用状态、熔断状态、依赖可用性和 CPU 预算确定参与插件。
- 按拓扑顺序执行 `onTickBegin`。
- 上一轮提交回执通过 `context.intents.previous()` 提供。

世界事实核验、Event Log/Ruin 扫描与建筑事件发布由信息类服务插件放在此阶段。Kernel 提供顺序与回执，不内建游戏事件生产器。事件生产者负责提取事实，订阅者负责消费。

### 4.3 tickExecute

```text
onTickExecute（plan） → arbitrate → commit
```

先运行所有可用插件的执行钩子，收集意图；然后统一仲裁，最后调用胜者的执行函数。插件应通过 `context.intents.submit` 提交改变游戏状态的操作。

仅执行阶段允许提交意图。框架检查提交者身份和阶段；直接绕过接口调用 Game API 属于插件违反约定，首版不通过修改全局原型拦截所有 API。

发生 planner 异常时，已提交的该插件意图被拒绝。依赖失败也会阻止使用者执行和提交。其他独立插件继续运行。关键插件失败则终止后续提交并进入当前 tick 的安全模式。

### 4.4 tickEnd

所有已经进入 begin 的插件按逆序执行 `onTickEnd`，包括自身 begin 或 execute 失败的插件；从未进入 begin 的插件不会收到 end。

随后更新失败、熔断等关键健康状态，并把本 tick 意图回执留在 heap 供下一 tick 核验。end 钩子异常不会阻断其他插件 end 或健康统计。

`OK` 或其他同步返回码只反映 API 提交情况；它们不证明世界变化已经完成。业务插件在下一 tick 对照 Game 状态核验事实。loop 若跳过了若干 tick，插件必须检查回执中的 `tick`，不能将旧回执视为紧邻上一 tick 的结果。

同一实例在同一 `Game.time` 重复调用 loop 不会重复执行，嵌套调用则拒绝。CPU 硬终止不保证 finally 执行，预留 CPU 只能降低风险，不能回滚游戏意图。

## 5. 插件协议与注册

插件协议设计：

- manifest：`id/version/requires/optional/provides/priority/critical`。
- 生命周期：`setup/onTickBegin/onTickExecute/onTickEnd`。
- 清理注册：在 setup 调用 `context.onDispose(cleanup)`。

插件 id 必须是合法、唯一的字符串，不能使用对象原型保留键。version 为正整数。`requires` 缺失拒绝启动；`optional` 存在时参与排序，缺失时允许启动。

稳定拓扑排序每轮从就绪节点中选择 priority 最高者，相同优先级按注册顺序决胜。所有声明服务的名称必须唯一，setup 结束前必须实际 provide。插件只能读取自身或声明依赖的插件提供的服务。

注册变更在边界使用候选 Map 原子验证。失败的命令批次丢弃，旧注册表保留；该 tick 不运行业务，下一 tick 可继续旧集合。移除不存在的插件安全忽略；启停未知插件会使该批次校验失败。

依赖停用、熔断或卸载时，使用者挂起。按逆序运行激活实例清理函数并移除服务。重新启用后创建新激活实例，健康记录在同一 Framework 实例中保留。

### 5.1 上下文与缓存生命周期

Context 在 setup 时创建并缓存；`tick`、意图队列都在使用时读取当前值，避免每 tick 重复创建环境函数、日志器和服务门面。

跨 tick 可以持有 Context，但 Game 对象只能在当前 tick 使用。持久化能力由独立 MemoryManager 的 Accessor 协议提供，不由 Framework 实现存储后端。

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

每轮回执只在 heap 保留至下一 tick，不写入 RawMemory，也不累计无限历史。global reset 后插件直接依据 Game 世界事实恢复；确实需要跨 reset 保留的关键事务由业务通过独立 MemoryManager 的 critical 策略提交。

## 7. 存储边界

Framework 不承担 RawMemory 解析、Memory 挂载、Segment 分配、数据迁移或写回。实例内健康表和默认 Profiler 统计在 global reset 后清空。

持久化由 [MemoryManager](./memoryManager.md) 独立管理；Framework 通过 Runtime 中的 MemoryHost 端口在 tick 边界驱动 begin/end，并在安全模式、CPU 未准入或插件 setup 失败时延后封存申请窗口。Runtime 统一装配遵循 [Core 架构](./README.md)。

## 8. ErrorMapper、Profiler 与故障隔离

ErrorMapper 使用同步的 `@jridgewell/trace-mapping`，避免依赖异步初始化。实现依据[解析库 API](https://github.com/jridgewell/sourcemaps/tree/main/packages/trace-mapping)，读取上传协议中的 `main.js.map` 模块。

解析器首次异常时懒加载；加载失败后本 global 生命周期内使用原始堆栈。V8 列号转换为 source map 的零基列后查询。非 main 帧保留不变。最多缓存 64 条、每条 16KB 的原始堆栈，防止重复错误无界增长。

捕获边界返回 `{ ok: true, value }` 或 `{ ok: false, failure }`。非 Error 抛出值也会规范化；字符串转换、映射和报告器再次失败时保留原始诊断，不击穿 loop。Promise 返回值被视为违反同步钩子契约并报告失败。

### 8.1 包装顺序与 CPU 归属

```text
ErrorBoundary.capture(metadata, callback)
  └── Profiler.wrap(pluginLabel, hook)
        └── 实际业务函数
```

业务异常先经过 Profiler finally 恢复调用栈和记录样本，再由外层边界捕获。堆栈映射和日志成本不计入出错插件，计入框架阶段及独立映射标签。

Profiler 的起始取样失败时直接执行原函数。结束时先恢复调用栈，再尝试取样和更新 heap 统计；观测故障不会覆盖原始异常或返回值。存储生命周期由宿主决定。

所有包装器按固定 label 缓存，不在每 tick 重新 wrap。Profiler calls 包含成功和失败调用。插件健康只在实例 heap 内维护失败和熔断，不为诊断写入 Memory。

### 8.2 熔断与安全模式

默认连续失败 3 个参与 tick 后熔断插件，后续挂起使用者并释放实例资源。未参与的 tick 不重置连续失败计数。`recover(id)` 清除熔断状态，下一 tick 重试。

普通插件失败隔离于该插件；关键插件失败阻止后续业务提交。注册表或 Kernel 故障进入安全模式，尝试完成已经进入阶段的清理。safeMode 表示最近一次 loop 状态，每次新 loop 会重新判断。

安全模式只提供诊断与可执行的收尾；首版没有内建最低生存策略。

FrameworkStatus 的 `memory.rawWriteError` 通过 MemoryHost.getStatus 投影最近一次主 Memory 写入错误，查询时生成独立快照；不读取存储实现或逐 tick 分配诊断对象。存储写入失败与插件执行故障分开，不增加失败计数或触发安全模式，允许插件通过正常 commit 缩减数据自救。此诊断协议已交付。

## 9. CPU 与性能观测

默认 `reserveCpu = 5`、`minBucket = 1000`：

- 普通插件要求 bucket 达标且当前 CPU 小于 limit 减去预留。
- critical 基础服务可使用 tickLimit 范围，但仍保留 reserveCpu。
- 意图提交使用 tickLimit 收尾边界。
- 所有已进入 begin 的插件仍尝试执行 end，插件必须控制收尾成本。
- CPU 不足时不抢占正在运行的函数，也不自动把当前执行闭包保存到下个 tick。

Profiler 标签设计：

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

Profiler 的初始开关由 Runtime 配置。业务优先级应由后续策略层确定：生存、防御、Spawn 和关键物流优先，布局重算与远期规划可延期。

## 10. 首版验收与后续范围

已交付：

- 可直接导出的 loop、首次 setup 和三个 tick 阶段。
- 插件依赖校验、稳定排序、边界启停与资源清理。
- Runtime 风格上下文、服务注册表和 EventBus 集成。
- Framework 不读写宿主存储、不挂载 Memory；global reset 清空 heap 健康状态。
- 同步 ErrorMapper、Profiler 加固与组合。
- CPU 准入、基础冲突通道、共享锁及提交回执。
- RoomShortcuts 服务插件与真实应用入口。
- 单元测试及真实 Rollup 产物的多 tick 沙箱运行和堆栈映射测试。

后续业务范围仍包括房间/跨房物流、资源管理、Spawn、自动布局、建造维护、防御战争、殖民资源房和交易模块。它们的具体决策与事实核验不属于 Framework 的交付范围。

使用方式见 [Framework 使用说明](../../usage/core/framework.md)。验证命令为类型检查、完整测试和不依赖密钥的构建；测试不会调用远端游戏上传 API。
