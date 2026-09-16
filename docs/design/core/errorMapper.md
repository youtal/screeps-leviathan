# ErrorMapper 设计

交付状态：同步捕获、源码堆栈映射、缓存、诊断出口与 Profiler 计时接入已交付。

ErrorMapper 是独立 Core 能力，负责把同步执行结果归一化为 `ExecutionResult<T>`，并在失败时生成 `PluginFailure`。它不决定插件熔断、生命周期或业务恢复策略，也不读写持久化存储。

工厂要求显式注入 LoggerFactory，并可接收 source map 加载器和结构化报告函数。它只依赖 contracts，不导入 Logger 或 Profiler 的具体实现。Runtime 在 Logger 之后创建 ErrorMapper；Framework 可通过 `setMeasure` 接入已经存在的 Profiler 计时函数。

source map 延迟到首次错误时同步加载，加载结果随 global 驻留 heap。堆栈映射缓存有固定容量；加载、映射、日志或报告失败都必须保留原始业务故障，不能让诊断路径覆盖被诊断错误。异步回调不属于该同步边界的承诺范围。
