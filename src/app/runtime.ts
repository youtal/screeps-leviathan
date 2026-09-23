/**
 * 文件摘要
 *
 * 模块角色：app 的实例创建处，将选定的 Core 能力和能力插件组成可运行的应用。
 *
 * 主要功能：创建一份 Runtime、一份 Framework，并登记 roomShortcuts 服务插件。
 *
 * 实现过程：先调用 createRuntime 组装基础能力，再创建 Framework；App 在实例创建后
 * 显式注册选定的能力插件，向游戏入口导出 framework，由其 loop 驱动插件和 MemoryManager。
 *
 * 技术要点：模块加载时完成实例创建和注册，插件 setup 延迟执行；本文件不直接访问游戏存储。
 * 这些实例跨 tick 复用，global reset 后重新创建；持久数据的恢复由 MemoryManager 负责。
 */
import { createFramework } from '@/core/framework';
import { createRuntime } from '@/core/runtime';
import { roomShortcutsPlugin } from './modules';

/** Runtime 负责按依赖顺序创建 Logger、MemoryManager、EventBus、Profiler 与 ErrorMapper。 */
const runtime = createRuntime();

/**
 * 应用单例仅由本处组装；闭包持续跨 tick 运行，避免每次 loop 重复订阅或丢失缓存。
 * 这里没有传 profiler.enabled，Profiler 按项目默认值关闭；需要采样时在创建
 * Runtime 时显式开启。loop 由 src/index.ts 导出，本文件不主动调用它。
 */
export const framework = createFramework({ runtime });

/** 注册只是排队；首次 loop 才执行插件 setup 并创建 RoomShortcuts 的缓存与事件订阅。 */
framework.register(roomShortcutsPlugin);
