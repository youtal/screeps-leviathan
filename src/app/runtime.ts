/**
 * 文件摘要：创建当前应用唯一的 Core Runtime 与 Framework 实例，并注册服务插件。
 *
 * app 只选择部署插件；Core 内部能力由 runtime 按单向依赖顺序组装一次，再整体交给
 * Framework 消费。所有实例在同一 global 生命周期内共享。模块加载阶段只完成注册，插件
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
import { createRuntime } from '@/core/runtime';
import { roomShortcutsPlugin } from './modules';

/** Runtime 负责按依赖顺序创建 Logger、MemoryManager、EventBus、Profiler 与 ErrorMapper。 */
const runtime = createRuntime();

/**
 * 应用单例仅由本处组装；闭包持续跨 tick 运行，避免每次 loop 重复订阅或丢失缓存。
 * 这里没有传 enableProfiler，Profiler 按项目默认值关闭；需要采样时在创建 Runtime
 * 时显式开启。loop 由 src/index.ts 导出，本文件不主动调用它。
 */
export const framework = createFramework({
  runtime,
  plugins: [roomShortcutsPlugin],
});
