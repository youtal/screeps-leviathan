# 使用说明

- [公共契约](./contracts.md)：类型导入、实现承诺与 Memory 类型交付边界。
- [Logger](./core/logger.md)：装配工厂、作用域日志、等级与邮件配置。
- [ErrorMapper](./core/errorMapper.md)：同步捕获、堆栈映射、默认报告去重与独立测试装配。
- [EventBus](./core/eventBus.md)：取得总线、订阅与发布、作用域与注意事项。
- [MemoryManager](./core/memoryManager.md)：装配、插件申请、长期访问器与深路径、提交语义、故障与诊断。
- [Framework](./core/framework.md)：插件注册、生命周期、事件回调与服务读取规则、意图与诊断。
- [Profiler](./core/profiler.md)：启停采样、包装函数和读取统计报告。
- [Runtime](./core/runtime.md)：创建共享总线、Profiler 和模块级环境上下文。
- [RoomShortcuts](./modules/roomShortcuts.md)：取得服务、查询接口、结果语义与缓存更新。
- [控制台工具](./utils/console.md)：着色、链接、模板工具、表单与帮助面板。
- [PriorityQueue](./utils/priorityQueue.md)：构造、比较器与接口。

本目录记录已提供公共能力的调用方法。按 `src/` 模块目录组织，如 `src/core/runtime/` 对应 `core/runtime.md`。新增模块或修改模块公共接口时，创建或更新对应说明，并同步分类索引与 [文档总导航](../README.md)。

未建立的使用说明在总导航中标为“待补充”或“待交付”，不以占位链接代替文档。
