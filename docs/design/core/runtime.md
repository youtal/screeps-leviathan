# Runtime 设计

交付状态：上下文派生、共享日志工厂、共享事件总线与统计装配已交付；统一内核装配未交付。

本文定义轻量上下文工厂的交付阶段协议。Root Runtime 的统一内核组装与生命周期端口设计见 [Core 架构](./README.md)。

Runtime 是核心设施的轻量组合层。它创建一条共享 EventBus、一个共享 LoggerFactory、一个可选 Profiler，并为每个模块派生带独立日志作用域和 Screeps `Game` 访问适配器的 `ModuleContext`。Runtime 不管理 tick 生命周期、插件依赖、Memory 挂载或写回；这些职责属于 Leviathan Framework。

`createRuntime()` 返回模块上下文工厂。日志工厂、总线与 Profiler 保存在工厂闭包中并由所有派生上下文共享，`env` 则按模块名创建，使日志来源清晰且测试可以替换运行环境。Runtime 本身不直接访问全局 `Memory` 或 RawMemory。

日志工厂由 Runtime 装配一次并注入模块 env、EventBus 与 Profiler，使全项目共用等级、输出端口和邮件策略；调用方可以注入 `logging` 复用已有配置，缺省时按项目默认等级创建。日志协议与降级行为见 [Logger 设计](./logger.md)。

独立 Runtime 默认把 Profiler 统计保存在闭包 heap 中，global reset 后丢失。这一默认行为防止它绕开统一的存储协议。需要保存统计时，调用者必须同时注入当前统计对象的访问器和写前标脏回调。

Runtime 允许受控可变闭包以减少重复创建日志工厂、总线和 Profiler 的开销。日志器、总线订阅、Profiler 标签和 heap 统计随当前 global 生命周期存在；脚本重载后由应用装配重新创建。模块不得跨 tick 保存 Game 对象。

Runtime 只提供依赖组合，不提供插件权限和资源清理。业务模块应优先通过 Framework 的 `PluginContext` 运行，以获得受控订阅、服务依赖和意图仲裁。直接使用 Runtime 适合底层设施测试或尚未接入插件生命周期的纯模块。
