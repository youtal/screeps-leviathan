# 使用说明

- [公共契约](./contracts.md)：类型导入、实现承诺与 Memory 类型交付边界。
- [Logger](./core/logger.md)：装配工厂、作用域日志、等级与邮件配置。
- [ErrorMapper](./core/errorMapper.md)：同步捕获、堆栈映射与独立测试装配。
- [MemoryManager](./core/memoryManager.md)：装配、插件申请、pending 处理、提交语义与诊断。
- [Framework](./core/framework.md)：插件注册、生命周期、服务、意图与诊断。
- [Profiler](./core/profiler.md)：启停采样、包装函数和读取统计报告。
- [Runtime](./core/runtime.md)：创建共享总线、Profiler 和模块级环境上下文。

本目录记录已提供公共能力的调用方法。按 `src/` 模块目录组织，如 `src/core/runtime/` 对应 `core/runtime.md`。新增模块或修改模块公共接口时，创建或更新对应说明，并同步分类索引与 [文档总导航](../README.md)。

未建立的使用说明在总导航中标为“待补充”或“待交付”，不以占位链接代替文档。
