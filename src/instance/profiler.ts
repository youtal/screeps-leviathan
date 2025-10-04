import { createEnvMethods } from '@/utils';
import { createProfiler, ProfilerMemory } from '@/modules/profiler';
import { DEFAULT_PROFILER_ENABLE } from '@/setting';

declare global {
  interface Memory {
    profiler?: ProfilerMemory;
  }
}

const envMethods = createEnvMethods('Profiler');
const getMemory = () => {
  if (!Memory.profiler) {
    Memory.profiler = {};
  }
  return Memory.profiler;
};

export const {
  wrap: profilerWrap,
  enable: enableProfiler,
  disable: disableProfiler,
  reset: resetProfiler,
  report: reportProfiler,
} = createProfiler({
  env: envMethods,
  getMemory,
  enable: DEFAULT_PROFILER_ENABLE,
}) || {};
