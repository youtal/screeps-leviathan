# 跨模块契约设计

交付状态：已交付。契约目录、公共类型抽离、实现显式类型承诺、CoreRuntime、Memory 长期访问器、深路径类型、同步装载错误契约与编译期回归均已交付。

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
| `memory.ts` | JSON、深只读、申请配置、长期 Accessor、深路径类型与宿主生命周期端口 MemoryHost（含装载及写入诊断） |

Profiler 统计记录和存储容器、EventBus 监听器索引、Framework 健康表、Goto 缓存及偏好 schema 归各自模块。构造参数包含内部数据结构时保留在模块内，不强制发布所有工厂参数。

## 维护约束

新增公共能力先定义最小调用协议，再由实现和消费者引用。兼容出口只转导同一声明，不复制类型；新增代码优先直接引用 contracts。契约变更同步使用说明与类型负例。环境扩展与资源通配声明保留在 `.d.ts`，普通协作协议使用显式导出的 `.ts`。

## Memory 协议

申请同步完成初始化或版本迁移，成功返回 global 生命周期内有效的 MemoryAccessor；失败抛错，不发布等待句柄。访问器直接提供 query、get、commit、remove，不包含 access/status 或可用性判别联合。

query/get 返回深只读引用；get 的 undefined 只表示路径缺失。commit 支持同步回调、顶层键赋值和 readonly 深路径赋值：回调重载保留结果，路径重载返回 void；remove 返回是否删除了目标。修改标脏所属分区，类型不暗示字段级序列化或即时落盘。路径类型需覆盖可选字段、动态 Record、数组及元组，并关联目标值类型；递归预算和超深动态入口在类型验证后确定。

深路径写入要求中间容器已经存在，缺失时抛错且不标脏；新增可选对象或 Record 条目须提交完整值。回调修改在执行前设置完整校验标记，路径写入及 remove 不取消该标记；只有经校验的路径修改无需收尾重复全量校验。类型签名须先通过 TypeScript 5.9 正负例及编译成本验证再冻结。类型检查只约束调用签名，历史数据按格式保留、申请时按受管约束校验，业务 schema 由模块负责。

MemoryHost 发布 bind、begin、end、getStatus，构造与 bind 无存储副作用。begin 先于模块申请同步装载，end 统一提交全部脏分区及结构变化；getStatus 至少发布 loadError 与 rawWriteError。装载异常、分区申请异常及写入异常具有不同的宿主处理边界，不用 pending 表达故障。

新 tick 的 begin 必须恢复遗漏 end 或硬终止遗留的阶段与临时锁；提交遵循平台接受、全部基线更新、最后清脏的顺序，残留脏项在 end 重试。单分区编码错误阻断本轮整体写入，停用模块不清除脏状态；诊断区分分区错误和整串错误。

申请、引用所有权、路径边界与提交时序以 [MemoryManager 设计](./core/memoryManager.md) 为准。类型发布不为未交付模块虚构可调用工厂。
