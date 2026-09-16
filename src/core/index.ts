/**
 * 文件摘要：作为 Core 层统一出口，聚合框架级基础能力。
 *
 * core 只提供框架基础能力：事件总线、框架辅助、Profiler 和 Runtime 工厂。
 * 它不负责创建当前 AI 的项目级单例；单例装配属于 src/app。
 *
 * 本文件只是转发出口：导入 core 不会创建总线或 Profiler、不读取 Memory、不访问
 * Game，所有资源都在调用具体工厂时才产生。使用 `export *` 是为了让子模块新增的
 * 公共符号自动出现在 core 出口，代价是会带出子模块的全部公共名字（default 导出
 * 不会被转发，重名符号也会被排除），因此各子模块需要自行收紧自己的出口范围。
 *
 * core/runtime 保留独立 Runtime 工厂，供底层集成与测试使用；正式业务模块应通过
 * Framework 的 PluginContext 取得能力，而不是直接使用该工厂。
 */
export * from './eventBus';
export * from './errorMapper';
export * from './framework';
export * from './logger';
export * from './memoryManager';
export * from './profiler';
export * from './runtime';
