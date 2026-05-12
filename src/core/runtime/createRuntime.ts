import { createBus } from '@/core/eventBus';
import { createProfiler } from '@/core/profiler';
import type { ProfilerMemory } from '@/core/profiler';
import { DEFAULT_PROFILER_ENABLE } from '@/setting';
import { createEnvMethods } from './env';
import type {
  CreateModuleContext,
  ModuleContext,
  ModuleContextOptions,
  RuntimeOptions,
} from './types';

/**
 * 扩展 Screeps Memory 类型，让 runtime 可以为默认 Profiler 存储创建槽位。
 *
 * 这里放在 createRuntime.ts 中，是因为默认 profiler memory 的创建逻辑
 * 也在本文件中。类型声明和实际写入位置放在一起，后续维护时更容易追踪。
 */
declare global {
  interface Memory {
    profiler?: ProfilerMemory;
  }
}

/**
 * 默认 Profiler Memory 访问器。
 *
 * Screeps 的 Memory 是跨 tick 持久化对象。Profiler 需要把统计数据写入
 * Memory.profiler；如果这个字段尚不存在，就在首次创建 runtime 时初始化。
 */
const createDefaultProfilerMemory = () => {
  if (!Memory.profiler) {
    Memory.profiler = {};
  }
  return Memory.profiler;
};

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
  const profiler =
    options.profiler === undefined
      ? createProfiler({
          env: createEnvMethods('Profiler'),
          getMemory: options.getProfilerMemory ?? createDefaultProfilerMemory,
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
