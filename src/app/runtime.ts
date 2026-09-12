/**
 * 文件摘要：创建当前应用唯一的日志工厂、MemoryManager 与 Framework 实例，并注册服务插件。
 *
 * 这里是 app 层的唯一组合根：日志、存储与框架按"先基础设施、后框架"的顺序组装一次，
 * 三个单例在同一 global 生命周期内被所有调用方共享。模块加载阶段只完成注册，插件
 * setup 延迟到首次 loop；Memory 的解析、Segment 激活与写回由 MemoryManager 在 tick
 * 边界驱动（Framework 调用 begin/end），因此导入本模块不访问 Game、不读写存储。
 *
 * global reset 后引擎重新求值整个 bundle：注册队列、服务表、事件订阅、房间索引等 heap
 * 状态全部重建，持久状态由 MemoryManager 按目录与 journal 恢复。
 *
 * 访问边界（AGENTS.md 第 9 节）：MemoryManager 是项目内唯一允许接触 Memory/RawMemory
 * 的模块；其它模块只能通过 `context.memory` 申请分区，不得绕开本装配自建存储入口。
 */
import { createFramework } from '@/core/framework';
import { createLogging } from '@/core/logger';
import { createMemoryManager } from '@/core/memoryManager';
import { roomShortcutsPlugin } from './modules';

/**
 * 日志工厂与存储共享同一实例：MemoryManager 的迁移、页占用与故障诊断沿用项目等级
 * 与输出端口（默认 warn/error 开启），Framework 的内核日志也走同一份配置。
 */
const logging = createLogging();

/** 存储实例在装配阶段创建，不解析存储；首次 loop 的 begin 才读取 RawMemory。 */
const memory = createMemoryManager({ logging });

/**
 * 应用单例仅由本处组装；闭包持续跨 tick 运行，避免每次 loop 重复订阅或丢失缓存。
 * 这里没有传 enableProfiler，内置 Profiler 按内核默认值 false 关闭；需要采样时
 * 在此显式开启。注意 setting.DEFAULT_PROFILER_ENABLE 只服务独立 Runtime 工厂，
 * Framework 路径不读取该常量。loop 由 src/index.ts 导出，本文件不主动调用它。
 */
export const framework = createFramework({
  plugins: [roomShortcutsPlugin],
  logging,
  memory,
});
