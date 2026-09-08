/**
 * 文件摘要：作为 App 层统一出口，暴露已完成依赖装配的 Runtime 与模块实例。
 *
 * core 与 modules 只提供工厂和协议；app 层负责创建当前 AI 使用的项目级
 * 单例。调用方通过本入口消费装配结果，无需了解各模块的内部文件路径。
 */
export * from './runtime';
export * from './modules';
