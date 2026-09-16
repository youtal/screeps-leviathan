# 跨模块契约设计

交付状态：契约目录、公共类型抽离、实现显式类型承诺、CoreRuntime 与编译期回归均已交付。

## 定位与依赖原则

`src/contracts/` 发布跨模块协作约定。提供方以工厂返回类型、对象类型标注或 `satisfies` 承诺结构，消费方通过 `import type` 依赖协议。契约不从具体实现导入类型，不通过 `ReturnType<typeof createX>` 反向推导公共接口，不创建运行时单例。

结构检查不证明设计意图、时序、持久性、标脏机制或错误恢复已经实现。语义由设计文档、运行时检查和测试共同约束。契约与业务数据模型严格分离，内部类型不得因为被测试或装配使用就自动提升为公共协议。

## 发布边界

| 文件 | 发布内容 |
| --- | --- |
| `logging.ts` | Logger/LogOptions、输出端口 LogOutput、装配配置 LoggingOptions、作用域覆盖 ScopeLogOptions 与工厂协议 LoggerFactory |
| `environment.ts` | EnvMethods、EnvContext |
| `eventBus.ts` | Bus、作用域、监听回调 |
| `events/index.ts` | 游戏事件注册表、事件名及载荷推导；与总线传输能力分开 |
| `profiler.ts` | Profiler、Wrap、HasWrap |
| `errorMapper.ts` | Phase、PluginFailure、ExecutionResult、ErrorMapper、诊断及计时回调 |
| `intent.ts` | GameIntent、IntentReceipt、CpuBudget |
| `plugin.ts` | 清单、生命周期、上下文、框架配置与管理接口 |
| `runtime.ts` | CoreRuntime、模块上下文与派生工厂 |
| `memory.ts` | JSON、深只读、申请配置、稳定 Accessor、局部就绪联合与宿主生命周期端口 MemoryHost |

Profiler 统计记录和存储容器、EventBus 监听器索引、Framework 健康表、Goto 缓存及偏好 schema 归各自模块。构造参数包含内部数据结构时保留在模块内，不强制发布所有工厂参数。

## 维护约束

新增公共能力先定义最小调用协议，再由实现和消费者引用。兼容出口只转导同一声明，不复制类型；新增代码优先直接引用 contracts。契约变更同步使用说明与类型负例。环境扩展与资源通配声明保留在 `.d.ts`，普通协作协议使用显式导出的 `.ts`。

Memory 的 pending 只影响依赖该 Accessor 的活动；ready 的数据引用不得跨 tick 使用。申请与读写语义见 [MemoryManager 设计](./core/memoryManager.md)。类型发布不为未交付模块虚构可调用工厂。
