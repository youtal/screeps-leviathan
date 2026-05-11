import { createBus } from '@/core/eventBus';
import { createProfiler } from '@/core/profiler';
import { DEFAULT_PROFILER_ENABLE } from '@/setting';
import { createEnvMethods } from '@/utils/env';
import { RuntimeContext, RuntimeOptions } from './types';

const createDefaultProfilerMemory = () => {
  if (!Memory.profiler) {
    Memory.profiler = {};
  }
  return Memory.profiler;
};

export const createRuntime = (options: RuntimeOptions = {}): RuntimeContext => {
  const env = options.env ?? createEnvMethods('Runtime');
  const bus = options.bus ?? createBus();
  const profiler =
    options.profiler === undefined
      ? createProfiler({
          env,
          getMemory: options.getProfilerMemory ?? createDefaultProfilerMemory,
          enable: options.enableProfiler ?? DEFAULT_PROFILER_ENABLE,
        })
      : options.profiler;

  return {
    bus,
    env,
    profiler,
  };
};
