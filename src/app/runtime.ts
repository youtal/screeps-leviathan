/**
 * 文件摘要：创建当前应用唯一的 Framework 实例并注册服务插件。
 * 模块加载阶段只完成注册，Memory 挂载和插件 setup 延迟到首次 loop；
 * 闭包在 global reset 后重新创建，持久化状态由 MemoryInterceptor 恢复。
 */
import { createFramework } from '@/core/framework';
import { roomShortcutsPlugin } from './modules';

/** 应用单例仅由本处组装；闭包持续跨 tick 运行，避免每次 loop 重复订阅或丢失缓存。 */
export const framework = createFramework({ plugins: [roomShortcutsPlugin] });
