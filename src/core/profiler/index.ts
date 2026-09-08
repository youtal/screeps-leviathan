/**
 * 文件摘要：汇总导出 Profiler 工厂及其公共类型协议。
 *
 * createProfiler 是运行时创建 profiler 的工厂；类型出口用于 runtime 和测试
 * 引用 ProfilerMemory、ProfilerContext 等协议。
 */
export { createProfiler } from './createProfiler';
export { Profiler, ProfilerContext, ProfilerMemory } from './types';
