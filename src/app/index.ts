/**
 * App 层统一出口。
 *
 * 这里暴露当前 AI 已经装配好的 runtime context 工厂和模块实例。
 * core 与 modules 不在 import 时创建项目级单例，只有 app 层负责这件事。
 */
export * from './runtime';
export * from './modules';
