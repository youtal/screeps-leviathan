/**
 * 文件摘要：创建当前应用唯一的 Framework 实例并注册服务插件。
 * 模块加载阶段只完成注册，Memory 挂载和插件 setup 延迟到首次 loop；
 * 闭包在 global reset 后重新创建，持久化状态由 MemoryInterceptor 恢复。
 *
 * 这里是 app 层的单例装配点：ES 模块只求值一次，导出的实例因此在同一 global
 * 生命周期内被所有调用方共享。导入本模块会立刻执行 createFramework（校验 manifest、
 * 冻结描述并排入 pending 队列），但不会读取 RawMemory/Memory、不访问 Game、不调用
 * 插件 setup，所以测试可以先导入再安装假 Game。
 *
 * global reset 后引擎重新求值整个 bundle，注册队列、服务表、事件订阅和房间索引等
 * heap 状态全部重建；跨 tick 的业务数据与插件健康状态由第一次 loop 时从 RawMemory
 * 解析出的 leviathan 分区恢复。
 */
import { createFramework } from '@/core/framework';
import { roomShortcutsPlugin } from './modules';

/**
 * 应用单例仅由本处组装；闭包持续跨 tick 运行，避免每次 loop 重复订阅或丢失缓存。
 * 这里没有传 enableProfiler，内置 Profiler 按内核默认值 false 关闭；需要采样时
 * 在此显式开启。注意 setting.DEFAULT_PROFILER_ENABLE 只服务独立 Runtime 工厂，
 * Framework 路径不读取该常量。loop 由 src/index.ts 导出，本文件不主动调用它。
 */
export const framework = createFramework({ plugins: [roomShortcutsPlugin] });
