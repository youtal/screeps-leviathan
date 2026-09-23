# Runtime 设计

交付状态：完整 Core Runtime、单向装配、模块上下文派生、Framework 注入、Memory 同步分区契约装配及 TaskScheduler 装配与上下文绑定已交付；Profiler 的 MemoryAccessor 持久化接入未交付。

## 定位

Runtime 是 Core 唯一的具体实现组合根。它负责按依赖有向无环图创建 Core 能力、持有每个 global 唯一实例，并通过 `CoreRuntime` 契约把完整能力集合交给 Framework。Runtime 不管理普通插件依赖、热插拔事务、CPU 准入或游戏决策。

## 装配协议

初始化顺序遵循“先创建依赖，再创建消费者”：

```text
Logger
├── EventBus
├── MemoryManager
├── Profiler
├── ErrorMapper
└── TaskScheduler（在 MemoryManager、Profiler、ErrorMapper 之后创建）
        ↓
CoreRuntime
        ↓
Framework
```

同级能力模块只引用 contracts，并在工厂参数中要求显式依赖。只有 Runtime 可以导入这些模块的具体工厂。前序能力严格不依赖后序能力；独立分支之间不强行建立无意义依赖。

`CoreRuntime` 发布 `getGame`、`logging`、`bus`、`memory`、`profiler`、`errorMapper`、`tasks` 和 `createContext`。Framework 必须接收完整 Runtime，不接受分散的基础能力替换项。

## 配置所有权

Runtime 的创建输入区分配置与实例替换：

- `RuntimeOptions` 只表达创建策略，并按 `platform`、`logging`、`memoryManager`、`profiler`、`errorMapper`、`taskScheduler` 分组；模块专属字段由对应模块定义和解释。
- `RuntimeOverrides` 只承载测试或特殊宿主提供的现成实例，不与生产配置混合；普通 App 不使用该入口。

`getGame` 属于共享平台端口，放入 `platform`。Profiler 的初始开关和 `ProfilerStorage` 属于 Profiler 配置；source map 加载与故障报告属于 ErrorMapper 配置；任务的缺省门限、缺省每 tick 上限、闲置回收期限与盈余水位属于 TaskScheduler 配置，其 `getGame`、Logger、ErrorMapper、Profiler 与 MemoryHost 由 Runtime 注入，不能从配置覆盖。Runtime 只解析依赖顺序并把整组配置交给拥有者，不为具体模块重复发布平铺字段。

ProfilerStorage 将统计访问器与可选标脏动作放在同一对象中。普通内存统计可省略标脏动作，持久化适配器必须提供；此要求由适配器实现者保证，类型本身不区分两类存储。默认端口使用 global 生命周期内的 heap 对象；持久化端口必须遵守 MemoryManager 访问边界。

实例替换优先于对应的创建配置；存在替换项时不调用该能力的默认工厂。`overrides.profiler: null` 表示没有统计器；`profiler: false` 仅在未提供实例替换时生效。`profiler: { enabled: false }` 创建可在之后开启采样的统计器。

## 上下文与状态

`createContext(moduleName, options)` 为普通模块派生 `ModuleContext`。所有上下文共享 Runtime 的 EventBus、Profiler、MemoryManager 与 TaskScheduler，并以模块名绑定 Memory owner 与任务 owner；每次调用创建独立 Env 和日志作用域。模块名与插件 id 共用任务 owner 命名空间，不能为空。Game 访问器在调用时取得当 tick 对象，不缓存跨 tick 引用。

Logger、总线订阅、Profiler 统计、ErrorMapper 缓存、任务注册表和派生工厂都驻留 heap，随 global reset 重建。MemoryManager 在首次 begin 同步装载命名空间并建立分区片段，申请时完成业务版本迁移；访问器在本 global 内长期有效。默认 Profiler 数据驻留 heap；持久化统计必须经 MemoryManager 契约接入，不能建立存储旁路。

## 故障与性能边界

Runtime 构造只进行实例装配，不读取 RawMemory；MemoryManager 与 TaskScheduler 由 Framework 在 tick 边界驱动。Profiler 可以通过配置设为 `false`，其不可用不解除错误隔离。ErrorMapper 的计时包装在 Framework 建立测量函数后接入。

Runtime 每个 global 只创建一次，避免重复总线、重复日志配置和并行存储管理器。测试可以注入契约实现，但也必须显式完成依赖装配。
