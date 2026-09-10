/**
 * 文件摘要：组合 EventBus、Profiler 与环境适配器，创建应用级模块上下文工厂。
 *
 * 根工厂用闭包保存共享服务；每次调用 createContext 只创建带模块名前缀的环境
 * 对象。默认 Profiler 只使用 runtime 闭包中的 heap 数据；需要持久化时必须注入
 * Framework 统一持久化接口提供的访问器和标脏回调。
 */
import { createBus } from '@/core/eventBus';
import { createProfiler } from '@/core/profiler';
import { DEFAULT_PROFILER_ENABLE } from '@/setting';
import { createEnvMethods } from './env';
import type {
  CreateModuleContext,
  ModuleContext,
  ModuleContextOptions,
  RuntimeOptions,
} from './types';

/**
 * 创建当前 AI 的 root runtime。
 *
 * 它不会直接返回 root context，而是返回一个 createContext 函数。
 * root runtime 内部持有框架级单例：
 * - bus：模块通信总线。
 * - profiler：性能统计器，可通过 options 替换、禁用或配置。
 *
 * app 层只需要调用一次 createRuntime，然后用返回的 createContext 为各模块
 * 派生 ModuleContext。这样模块可以共享核心单例，又拥有自己的日志前缀。
 */
export const createRuntime = (
  options: RuntimeOptions = {}
): CreateModuleContext => {
  const bus = options.bus ?? createBus();
  /** 独立 Runtime 没有 Framework 提交边界，默认统计仅驻留 heap。 */
  const heapProfilerMemory = {};
  const profiler =
    options.profiler === undefined
      ? createProfiler({
          env: createEnvMethods('Profiler'),
          getMemory: options.getProfilerMemory ?? (() => heapProfilerMemory),
          markMemoryDirty: options.markProfilerMemoryDirty,
          enable: options.enableProfiler ?? DEFAULT_PROFILER_ENABLE,
        })
      : options.profiler;

  const createContext = (
    moduleName: string,
    moduleOptions: ModuleContextOptions = {}
  ): ModuleContext => {
    /**
     * 每次派生模块上下文时重新创建 env。
     *
     * bus/profiler 共享 root 单例；env 则按 moduleName 独立创建，让日志
     * 能准确标识来源模块，也允许不同模块使用不同日志配置。
     */
    return {
      bus,
      env: createEnvMethods(
        moduleName,
        moduleOptions.log,
        moduleOptions.notify
      ),
      profiler,
    };
  };

  return createContext;
};
