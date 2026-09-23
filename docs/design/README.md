# 设计方案

设计案只记录设计意图与交付状态。按 `src/` 模块目录组织，架构级设计放在所属层级的 `README.md`。

- [公共契约](./contracts.md)：独立类型发布、实现承诺与内部类型边界。
- [Logger](./core/logger.md)：等级与作用域、输出端口、邮件策略与装配边界。
- [ErrorMapper](./core/errorMapper.md)：同步错误边界、堆栈映射、默认报告去重与诊断降级。
- [EventBus](./core/eventBus.md)：作用域与广播规则、事件注册表、快照派发与订阅者故障隔离。
- [Core 架构及开发原则](./core/README.md)：内核分类、统一装配、注册及开发边界。
- [MemoryManager](./core/memoryManager.md)：模块独立分区、分区 JSON 缓存、长期访问器、深路径读写与同步故障协议。
- [Framework](./core/framework.md)：生命周期、插件事务、故障隔离、CPU 与意图仲裁。
- [Profiler](./core/profiler.md)：嵌套计时、统计存储与故障隔离。
- [Runtime](./core/runtime.md)：共享能力和上下文组合。
- [TaskScheduler](./core/taskScheduler.md)：生成器驱动的跨 tick 任务调度、空闲额度内的 CPU 准入、实例语义、失败归属与硬终止恢复。
- [能力层](./capabilities/README.md)：与 Screeps 耦合的通用能力如何分层、如何被消费，以及服务令牌协议；RoomShortcuts 已归入能力层。
- [goto](./modules/goto.md)：原生寻路、AB/ABC 矩阵、有向房间权重、压缩方向缓存与工作状态避让策略。
- [RoomShortcuts](./capabilities/roomShortcuts.md)：房间查询缓存、事件更新与租约。
- [控制台工具](./utils/console.md)：控制台 HTML 约束、模板片段协议、表单与帮助面板、信任边界。
- [PriorityQueue](./utils/priorityQueue.md)：二叉堆协议、复杂度与所有权。

源码和使用文档入口见 [文档总导航](../README.md)。
