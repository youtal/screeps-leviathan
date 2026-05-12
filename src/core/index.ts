/**
 * Core 层统一出口。
 *
 * core 只提供框架基础能力：事件总线、框架辅助、Profiler 和 Runtime 工厂。
 * 它不负责创建当前 AI 的项目级单例；单例装配属于 src/app。
 */
export * from './eventBus';
export * from './framework';
export * from './profiler';
export * from './runtime';
