/**
 * 文件摘要
 *
 * 模块角色：Core 层的统一导出入口，汇集基础能力的工厂和公开类型。
 *
 * 主要功能：提供 EventBus、ErrorMapper、Framework、Logger、MemoryManager、Profiler 和 Runtime 的出口。
 *
 * 实现过程：逐个转发子模块入口，使其公开符号可由 Core 入口引用。
 *
 * 技术要点：本文件不调用工厂或创建应用单例；Core 同级实现仍须通过 contracts 和显式注入协作，
 * 不能借此入口相互依赖。实例组合由 core/runtime 负责，应用选择与实例持有由 app 负责。
 */
export * from './eventBus';
export * from './errorMapper';
export * from './framework';
export * from './logger';
export * from './memoryManager';
export * from './profiler';
export * from './runtime';
