# ErrorMapper 设计

交付状态：同步捕获、源码堆栈映射、缓存、诊断出口与 Profiler 计时接入已交付。

ErrorMapper 是独立 Core 能力，负责把同步执行结果归一化为 `ExecutionResult<T>`，并在失败时生成 `PluginFailure`。它不决定插件熔断、生命周期或业务恢复策略，也不读写持久化存储。

工厂以第一参数显式接收 LoggerFactory，以第二参数 `ErrorMapperOptions` 接收 source map 加载器和结构化报告函数；Runtime 通过 `errorMapper` 配置组转交这组选项。它只依赖 contracts，不导入 Logger 或 Profiler 的具体实现。Runtime 在 Logger 之后创建 ErrorMapper；Framework 可通过 `setMeasure` 接入已经存在的 Profiler 计时函数。

source map 延迟到首次映射请求时同步加载，加载结果随 global 驻留 heap。堆栈同时是映射缓存的键，因此捕获入口与公开的 `mapStack` 使用同一条长度上限，缓存占用不随输入长度增长。堆栈映射缓存有固定容量；加载、映射、日志或报告失败都必须保留原始业务故障，不能让诊断路径覆盖被诊断错误。异步回调不属于该同步边界的承诺范围。

默认报告出口遵循 [Core 架构 §10](./README.md) 的“一次事件一次”：以（插件、阶段）为键记住最近一次已记录的消息，同一消息连续出现只记录一次，消息变化时重新记录；同一插件在同一阶段成功执行一次后删除该键，故障复发时重新记录。同一阶段内的不同操作共用一个键，其中一步成功会提前重置，最多多记录一次。去重表只驻留 heap，大小受插件数与阶段数限制，global reset 后清空。去重只作用于日志输出：`capture` 每次失败仍返回完整的 `PluginFailure`。注入的 `report` 回调不经过去重，每次故障都会收到，去重与限流由注入方决定。
