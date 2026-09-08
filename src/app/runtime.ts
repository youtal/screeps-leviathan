/**
 * 文件摘要：创建应用级 Runtime，并向业务模块提供统一的上下文工厂。
 *
 * ES 模块只会求值一次，因此此处导出的闭包自然充当应用级单例入口；实际的
 * 总线和 Profiler 仍由 core/runtime 创建并封装，业务模块不会接触根状态。
 */
import { createRuntime } from '@/core/runtime';

/**
 * 当前 AI 的 root runtime 工厂实例。
 *
 * createRuntime 只在 app 层调用一次，返回的 createContext 会闭包持有
 * root bus/profiler 单例。普通模块通过 createContext 派生自己的 ModuleContext。
 */
export const createContext = createRuntime();
