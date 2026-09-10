/**
 * 文件摘要：汇总导出 Runtime 工厂、环境适配器与上下文类型。
 *
 * core/runtime 的公共出口：app 与业务模块统一从 '@/core/runtime' 导入，避免
 * 依赖目录内部文件结构。core/runtime 不创建项目级单例，只导出创建 root runtime
 * 的工厂、模块 env 工厂，以及相关上下文类型；真正的项目装配发生在 src/app。
 *
 * 本文件只做重导出，没有运行时状态与副作用；事件协议类型由 '@/core/eventBus'
 * 提供，不在此处转出。
 */
export { createEnvMethods } from './env';
export { createRuntime } from './createRuntime';
/**
 * 类型统一走 `export *`：types.ts 只包含类型与接口，编译后不会留下代码，
 * 后续新增上下文类型也无须在这里重复登记。
 */
export * from './types';
