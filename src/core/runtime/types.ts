/**
 * 文件摘要：保存 Runtime 装配参数，统计载荷属于 Profiler 内部模型。
 * 仅维护模块内部类型及契约兼容出口，不创建运行时状态或调用宿主。
 */
import type { Bus, LoggerFactory, MemoryHost, Profiler } from '@/contracts';
import type { ProfilerMemory } from '../profiler/types';
export type {
  Wrap,
  HasWrap,
  EnvMethods,
  EnvContext,
  ModuleContextOptions,
  ModuleContext,
  CreateModuleContext,
} from '@/contracts';
/**
 * 创建 root runtime 时可以注入的依赖。
 *
 * 这些选项主要服务于测试和未来的不同运行模式：
 * - bus：允许注入测试总线或已有总线。
 * - logging：注入 Runtime 组装的日志工厂；所有派生上下文与内核消费者共用它，
 *   缺省使用 core/logger 的兜底工厂（只服务独立调用与测试）。
 * - memory：注入 Runtime 组装的 MemoryManager；派生上下文会按模块名绑定申请入口。
 *   独立 Runtime 不驱动 tick 生命周期，调用方需自行在边界调用它的 begin/end。
 * - profiler：允许禁用、替换或复用 profiler；注入后 enableProfiler 不再生效。
 * - enableProfiler：控制默认 profiler 初始开关。
 * - getProfilerMemory：控制 profiler 数据落在哪里。它必须返回同一个常驻对象，
 *   访问器每次写入前都会重新调用它并原地累加；返回临时副本会让统计丢失。
 * - markProfilerMemoryDirty：与访问器配套，在 Profiler 原地写入前显式标脏，
 *   让注入存储的宿主知道该把哪块数据写回，避免整棵 Memory
 *   重新序列化。
 *
 * 未提供 getProfilerMemory 时，createRuntime 使用闭包 heap 对象作为默认落点，
 * 统计不进入持久化 Memory。
 */
export interface RuntimeOptions {
  bus?: Bus;
  logging?: LoggerFactory;
  memory?: MemoryHost;
  profiler?: Profiler | null;
  enableProfiler?: boolean;
  getProfilerMemory?: () => ProfilerMemory;
  markProfilerMemoryDirty?: () => void;
}
