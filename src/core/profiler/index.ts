/**
 * 文件摘要
 *
 * 模块角色：core/profiler 的公共入口，供 Runtime 创建统计器并引用构造所需的类型。
 *
 * 主要功能：导出 createProfiler、Profiler 接口、ProfilerContext 和 ProfilerMemory。
 *
 * 实现过程：从 createProfiler.ts 转发工厂，从 types.ts 转发公共操作、上下文和统计表类型。
 *
 * 技术要点：导入本入口不读取 CPU、不创建统计表，也不包装函数；这些动作由工厂及返回实例执行。
 * 内部统计访问器保留在模块内，业务只通过公共 Profiler 接口使用计时能力。
 */
export { createProfiler } from './createProfiler';
export { Profiler, ProfilerContext, ProfilerMemory } from './types';
