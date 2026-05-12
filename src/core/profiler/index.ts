/**
 * Profiler 模块出口。
 *
 * createProfiler 是运行时创建 profiler 的工厂；类型出口用于 runtime 和测试
 * 引用 ProfilerMemory、ProfilerContext 等协议。
 */
export { createProfiler } from './createProfiler';
export { Profiler, ProfilerContext, ProfilerMemory } from './types';
