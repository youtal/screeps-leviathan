# Logger 设计

交付状态：Logger、LogOptions 契约已交付；模块目录已建立；内核 Logger 实现与 Runtime 强制装配未交付。

Logger 是基础输出能力，负责日志等级、模块作用域、格式化及输出端口，不参与具体游戏对象管理和业务决策。公共调用协议由 `src/contracts/logging.ts` 发布，消费者不依赖输出实现。

Runtime 负责创建共享基础设施并派生模块级日志。日志必须能在 Memory、Profiler 或错误映射不可用时独立输出，避免递归诊断依赖。HTML 工具和房间链接不因复用格式化函数而自动成为内核职责。

具体装配和失败降级遵循 [Core 架构](./README.md)；目录占位不代表内核实例已经可用。
