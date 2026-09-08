/**
 * 文件摘要：装配当前 AI 使用的业务模块，并导出可供主循环调用的模块实例。
 *
 * 本文件是依赖注入的组合边界：模块工厂保持可复用，只有 app 层把共享的
 * Runtime 上下文交给它们。新增模块时应在这里完成实例化，避免模块文件在
 * import 阶段自行创建总线、Profiler 等全局资源。
 */
import { createRoomShortcuts } from '@/modules/roomShortcuts/createRoomShortcuts';
import { createContext } from './runtime';

/**
 * 当前 AI 装配出的 roomShortcuts 单例。
 *
 * `createContext` 会为模块生成独立日志环境，同时复用根 Runtime 中的事件总线
 * 和 Profiler。字符串参数用于标识日志来源，不参与模块业务逻辑。
 */
export const roomShortcuts = createRoomShortcuts(
  createContext('StructureShortcuts')
);
