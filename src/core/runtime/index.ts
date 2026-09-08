/**
 * 文件摘要：汇总导出 Runtime 工厂、环境适配器与上下文类型。
 *
 * core/runtime 不创建项目级单例，只导出创建 root runtime 的工厂、
 * 模块 env 工厂，以及相关上下文类型。真正的项目装配发生在 src/app。
 */
export { createEnvMethods } from './env';
export { createRuntime } from './createRuntime';
export * from './types';
