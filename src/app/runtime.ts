import { createRuntime } from '@/core/runtime';

/**
 * 当前 AI 的 root runtime 工厂实例。
 *
 * createRuntime 只在 app 层调用一次，返回的 createContext 会闭包持有
 * root bus/profiler 单例。普通模块通过 createContext 派生自己的 ModuleContext。
 */
export const createContext = createRuntime();
