/**
 * 文件摘要：汇总导出 Profiler 工厂及其公共类型协议。
 *
 * createProfiler 是运行时创建 profiler 的工厂；类型出口用于 runtime 和测试
 * 引用 ProfilerMemory、ProfilerContext 等协议。
 *
 * 本入口不导出 memory.ts 的 createMemoryAccessor：统计存储只应通过宿主提供的 getMemory
 * 适配，避免绕过 Framework 的持久化边界（测试仍可按路径直接导入该文件）。导入本入口
 * 不创建 Profiler、不访问 Game/Memory；工厂返回 null 的失败契约由调用方处理。
 */
export { createProfiler } from './createProfiler';
export { Profiler, ProfilerContext, ProfilerMemory } from './types';
