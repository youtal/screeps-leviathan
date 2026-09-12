# MemoryManager 使用状态

`src/core/memoryManager/` 只有目录占位，没有可运行的 MemoryManager、Segment 分配器或申请工厂。契约声明不等于实现交付。

Framework 持久化接入已停用：不提供 `context.persistence`，不接受旧 persistence/migrate 声明，不挂载 Memory、不读写 RawMemory。健康记录和默认 Profiler 统计只在实例 heap 内保留，global reset 后清空。已有游戏存储未被删除或迁移，但不会被框架恢复。

Memory 类型可从 `@/contracts/memory` 导入；申请字段及使用约束见 [公共契约使用说明](../contracts.md)。指定 priority 的模块必须在 pending 时仅跳过 Memory 相关行为，并在后续 tick 重试；不得因此暂停全部活动。

存储实现交付前，不应编写依赖成功申请持久状态的运行时代码。完整协议见 [设计](../../design/core/memoryManager.md)。
