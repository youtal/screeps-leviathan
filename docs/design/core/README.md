# Core 架构设计及开发原则

交付状态：已交付。统一内核装配、单向依赖边界、事务性插件注册、Memory 同步分区申请及长期访问契约接入均已交付。TaskScheduler 的内核能力身份与 Runtime 组装未交付，设计见 [TaskScheduler](./taskScheduler.md)。

本设计定义 Core 的架构与开发原则。模块设计入口：[Framework](./framework.md)、[Runtime](./runtime.md)、[Profiler](./profiler.md)、[ErrorMapper](./errorMapper.md)、[MemoryManager](./memoryManager.md)、[TaskScheduler](./taskScheduler.md)。

与 Screeps 耦合的通用能力（roomShortcuts、goto 等）不进入 Core，位于同级的能力层，见[能力层设计](../capabilities/README.md)。

## 1. 定位与职责

Core 提供脚本基础能力及执行框架。业务模块使用这些能力完成游戏逻辑，不能通过提升注册等级获得额外的业务特权。

| 层次 | 职责 | 不承担的职责 |
| --- | --- | --- |
| App | 创建唯一 Runtime、创建 Framework、选择并装配插件 | 实现存储、日志等底层机制 |
| Runtime | 统一创建、连接并持有内核能力，派生模块上下文 | 普通插件依赖排序、热插拔事务、游戏决策 |
| Framework | 驱动生命周期、身份校验、插件注册事务、故障隔离、CPU 准入和 Intent 仲裁 | 再创建一套 Runtime 内核实例 |
| 内核插件 | 提供日志、事件、观测、错误映射、持久化、跨 tick 任务调度能力 | 具体游戏对象管理及业务决策 |
| 普通插件 | 查询游戏世界、规划与执行业务、提供领域服务 | 接管内核生命周期和底层存储 |

目标装配关系：

```text
App
├── Runtime（每个应用一个，global reset 后重建）
│   ├── Logging
│   ├── EventBus
│   ├── ErrorMapper
│   ├── MemoryManager
│   ├── Profiler
│   └── TaskScheduler
└── Framework（消费上述 Runtime）
    ├── 生命周期、注册表、故障与调度机制
    └── 普通插件集合
```

Runtime 不导入 Framework 实现；内核模块通过端口和回调接入，不反向调用普通插件注册接口。Framework 可以消费 Runtime 的能力协议，普通插件只取得自己的上下文，不取得 Root Runtime 管理端口。

## 2. 内核插件的认定标准

内核插件属于脚本基础能力，几乎不涉及具体游戏对象或事务决策。模块重要、执行频繁或使用者众多，本身不足以成为内核插件。

内核能力集合为：

| 内核能力 | 职责与边界 |
| --- | --- |
| Logging | 日志等级、作用域、格式化和输出端口；无需依赖 Memory、Profiler 或 ErrorMapper 才能输出 |
| EventBus | 事件发布订阅及资源清理；不决定游戏业务行为 |
| Profiler | 调用计时、统计及报告；观测失败不能反向阻塞被观测能力 |
| ErrorMapper | 堆栈还原与错误规范化；映射失败保留原始诊断 |
| MemoryManager | 模块独立分区、长期 Accessor、深路径读写、分区 JSON 缓存与主存储提交 |
| TaskScheduler | 生成器驱动的协作式跨 tick 任务调度；只做调度、CPU 准入与失败隔离，不理解具体业务计算内容 |

`MemoryAccessor` 是 MemoryManager 对模块提供的句柄，而非额外内核实例。Logging 由 Runtime 统一组装，为普通模块、EventBus、Profiler、ErrorMapper、MemoryManager 和 TaskScheduler 注入作用域日志能力。

内核可以使用 `Game.time`、`Game.cpu`、`RawMemory`、控制台和模块加载等平台原语。RoomShortcuts、Goto、生产、物流、防御等理解游戏领域的组件归为普通插件。染色、HTML 模板等纯工具不必整体提升为内核；Logger 与房间链接等领域辅助函数应保持边界。

PluginRegistry、生命周期执行器、CPU 准入、IntentBroker 属于 Framework 内部机制，不因为处于 `core/` 就成为内核插件。内核插件也不必具有 tick 钩子，例如 Logging 和 ErrorMapper 可以只提供常驻能力。

## 3. 强制装配与事务性注册

注册模式与能力分类是不同维度。

- 强制装配：App 实例化时完成内核集合创建、身份和连接校验；集合固定，不能通过普通 `disable/unregister` 卸载。Profiler 停止采样属于能力配置，不等于移除内核组件。
- 事务性注册：App 实例化完成后接受普通插件注册、启停和卸载命令，在 tick 边界整批验证并发布；失败保留原注册表。

如 App 需要固定普通插件，可将其作为强制装配的应用组成部分，但它仍是普通插件，不取得内核能力身份。哪些业务插件必须固定装配由 App 决定，不将 RoomShortcuts 或 Goto 自动列为内核。

实例化阶段只装配能力；主存储由首次 begin 同步装载，分区在申请时同步完成初始化或业务数据版本迁移。申请必须在成功的 begin 之后，允许后续 tick 申请，不设集中分配窗口。强制装配不能绕过引擎硬 CPU 终止。

## 4. 身份及能力作用域

`manifest.id` 是开发者明确声明的稳定业务主键。注册表通过格式校验和重复检测保证同一应用内已接受插件 ID 唯一；跨版本、跨 global 的语义稳定性由开发者维护。注册入口保存描述副本，外部修改不改变已接受身份。

卸载保留持久化身份及数据；无关模块不能复用旧 ID。更名需要显式数据迁移。内核和普通插件应共享全局身份约束，内核保留命名空间的确切拼写在实现时固定。

一个插件一份 Memory 可以直接以插件 ID 归属；支持多份时使用 `(pluginId, localMemoryId)`。Framework 为上下文绑定已校验的 owner，模块只填写局部 ID。不能向普通插件暴露可任意指定 owner 的 Root Runtime 工厂。这里是应用内一致性边界，不是同一 JavaScript isolate 中针对恶意代码的安全沙箱。

## 5. Runtime 组装与生命周期

`createRuntime()` 返回完整 Root Runtime，以一个对象交付 Game 访问器、日志、事件总线、观测、错误映射、存储端口和模块上下文工厂。App 将其注入 Framework，Framework 只消费不重建，同一应用的内核能力由该 Runtime 唯一持有。

具体实现依赖采用有向无环图，而不是要求所有模块形成无意义的全序：

```text
Logger
├── EventBus
├── MemoryManager
├── Profiler 的环境日志
└── ErrorMapper
    └── TaskScheduler（依赖 Logger、ErrorMapper、Profiler）

上述实例 ──→ Runtime ──→ Framework ──→ 普通插件
```

同级 Core 模块只依赖 contracts，不导入彼此的工厂。Runtime 是唯一可导入上述具体工厂的组合根；前序模块不得依赖后序模块。ErrorMapper 的计时由 Framework 在 Profiler 已经存在后接入，错误报告和统计回路必须防止递归。TaskScheduler 依赖 Logger（自身诊断）、ErrorMapper（任务失败的堆栈捕获与映射）和 Profiler（任务分片计时），不依赖 EventBus 或 MemoryManager。

Framework 是 tick 驱动者，Runtime 封装内核组件的必要顺序：

```text
Runtime 开始本 tick：Memory 加载/恢复、必要观测准备
→ Framework 执行插件初始化与各生命周期、Intent 仲裁
→ 所有普通插件收尾
→ Runtime 完成观测收尾
→ MemoryManager 编码全部脏分区、复用 clean 片段、拼接并提交主存储
```

不要求 EventBus 或 Profiler 为统一接口虚构无意义钩子。Memory 收尾不依赖普通插件排序，不受普通插件启停控制。持久化提交本身的耗时统计若发生在本次 flush 之后，应留待后续提交，不能为保存自身统计递归 flush。

Profiler 若接入持久化，须在存储 begin 成功后同步申请分区；申请失败不得覆盖历史统计。默认 heap 统计的生命周期由 Profiler 自身定义。

## 6. Memory 同步访问契约

采用 [MemoryManager 设计](./memoryManager.md) 的模块独立分区与长期访问器。申请成功即可直接 query/get/commit/remove，句柄跨 tick 有效；申请失败抛出可定位的错误，不返回 pending。深路径用于开发体验，序列化和片段缓存的粒度固定为分区。

模块只通过显式修改 API 标脏，不通过 query/get 返回的引用旁路修改。无待提交变化时收尾进行 O(1) 判断；有修改时编码全部脏分区，其他对象不遍历。所有分区在本 tick end 统一提交；写入失败保留 heap 修改、脏状态与已提交片段，下一 tick 按最新工作数据重试。单分区编码失败阻断整体提交，模块停用不清除其脏状态；真实的新 tick 顶层须恢复中断遗留阶段，具体恢复协议见 MemoryManager 设计。

## 7. 性能、故障与开发原则

- 每个 global 只创建一套内核能力；避免模块级自建实例绕过统一配置。
- **Memory 访问边界（强制）**：`core/memoryManager` 是唯一允许接触 Memory/RawMemory 的模块；其它模块只能通过 `context.memory` 申请分区。越界访问属于阻断问题，由 `test/memoryBoundary.test.ts` 自动扫描 `src/` 拦截。
- 优先小函数、明确输入输出及端口注入；允许闭包缓存和受控原地更新，注明创建、失效、清理和 reset 行为。
- 按 tick 调用平台访问器，不长期保存 Game 对象。限制统计标签、错误缓存和未释放订阅的常驻规模。
- 区分配置错误、装载损坏、分区申请失败、写入失败和插件执行失败；存储故障不能伪装成等待状态。
- 内核失败按能力降级：日志保留最小输出、映射退回原堆栈、观测可暂停；存储装载故障保护原始数据并进入宿主错误边界；写入失败保留访问器可用，不自动阻止业务缩减数据后重试。
- 构造阶段尽量只组装与校验，存储副作用在明确的生命周期执行；测试可以替换平台和输出端口。
- 修改公共契约时同步设计与使用文档，源码遵循根 AGENTS.md 注释要求；完成代码改动后按仓库要求验证，不自动部署。

## 8. 命名原则

采用 `core/framework` 与 `createFramework` 表达插件生命周期、注册事务和能力接入框架。Kernel 表示内核概念，不要求另设同名模块。

模块命名应稳定地表达职责。更名须同步处理导入、公共 API、文档及测试，不能将路径更名作为职责拆分的前提。

## 9. 实施边界

目标目录包括 `core/runtime`、`core/framework` 以及独立的 Logging、EventBus、Profiler、ErrorMapper、MemoryManager、TaskScheduler 模块。跨模块公共协议集中在 `src/contracts/`，包括 Memory、Logger、任务调度与基础设施的调用约定；业务健康状态和内部存储模型归所属模块。实现以显式类型标注承诺接口结构，不代表已经实现设计意图。契约不得反向导入具体实现。详见 [契约设计](../contracts.md)。

内核接口具体命名、公共 API 兼容方式、数据格式升级和迁移测试须在交付前确定。设计文档只表达设计意图及交付状态，调用方法由对应使用说明承载。

## 10. 内核能力使用 Logger 的通用规范

Logger 是内核能力，由 Runtime 组装唯一工厂；内核模块与普通模块都通过注入获得作用域日志器。接入时必须遵守：

1. **注入而不自建**：模块在自身工厂中要求调用方提供 `LoggerFactory`；模块内部不得导入 Logger 具体实现、使用默认单例或调用 `createLogging()`。独立测试也在测试装配边界显式创建并注入 Logger。
2. **作用域固定且每实例派生一次**：以模块名作为作用域（`MemoryManager`、`EventBus`、`Profiler`、`ErrorMapper`），在工厂创建时 `scope()` 一次并复用；禁止每次故障重新派生。
3. **只在状态迁移与故障上输出**：每 tick 都会发生的路径（提交、心跳）只允许 `debug`；状态迁移用 `info`（默认关闭）；可自愈异常用 `warn`；不可自愈的数据问题用 `error`。不得在热路径输出 `info` 及以上等级。热路径或构造昂贵的消息传惰性回调（`log.debug(() => …)`）或先以 `isEnabled` 判断，避免等级关闭时仍付出拼接与计算成本。
4. **一次事件一次**：同一故障、同一分区、同一原因只记录首次或原因变化的那一次，恢复后重置去重状态，避免逐 tick 刷屏。
5. **日志不是唯一诊断**：结构化状态（`getStatus()` 等）是权威出口，日志是补充；日志失败不得改变业务流程，也不得把 logger 或日志文本写入持久数据。
6. **邮件策略跟随装配**：内核能力不自行开启 `notify`，是否发送邮件由 App 的装配策略决定。
7. **测试要求**：模块测试注入收集文本的工厂，覆盖"正常路径静默""故障只记一次""热路径不输出""输出端口抛错不影响业务"。

等级回退、作用域前缀、端口异常吞掉等由 Logger 自身保证，见 [Logger 设计](./logger.md) 与 [Logger 使用说明](../../usage/core/logger.md)。
