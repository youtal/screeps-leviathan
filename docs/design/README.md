# 设计方案

设计案只记录设计意图与交付状态。按 `src/` 模块目录组织，架构级设计放在所属层级的 `README.md`。

- [公共契约](./contracts.md)：独立类型发布、实现承诺与内部类型边界。
- [Logger](./core/logger.md)：等级与作用域、输出端口、邮件策略与装配边界。
- [Core 架构及开发原则](./core/README.md)：内核分类、统一装配、注册及开发边界。
- [MemoryManager](./core/memoryManager.md)：固定 10 个 Segment、局部就绪、启动分配、Raw/Segment 提交与迁移恢复。
- [Framework](./core/framework.md)：生命周期、插件事务、故障隔离、CPU 与意图仲裁。
- [Profiler](./core/profiler.md)：嵌套计时、统计存储与故障隔离。
- [Runtime](./core/runtime.md)：共享能力和上下文组合。
- [goto](./modules/goto.md)：跨房路由、CostMatrix、Flow Field 与避让。
- [goto 成本场](./modules/goto-cost-field.md)：成本场与方向场布局、参考场索引、`cm` / `cmin` 与残差复用。
- [RoomShortcuts](./modules/roomShortcuts.md)：房间查询缓存、事件更新与租约。

源码和使用文档入口见 [文档总导航](../README.md)。
