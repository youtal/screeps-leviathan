# Logger 使用状态

`src/core/logger/` 只有目录占位，没有可导入的工厂或内核插件。

日志能力仍可通过模块的 `context.env.log` 使用；底层 `createLog` 保留在 `@/utils/console`，本轮没有移动日志实现。其返回值遵循 `Logger`，配置使用显式导入的 `LogOptions`，两者来自 `@/contracts/logging`。

接口示例见 [公共契约使用说明](../contracts.md)，装配意图见 [Logger 设计](../../design/core/logger.md)。
