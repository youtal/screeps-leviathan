import { Bus } from '@/core/eventBus';
import { Profiler, ProfilerMemory } from '@/core/profiler';
import { EnvMethods } from '@/utils/types';

export interface RuntimeContext {
  bus: Bus;
  env: EnvMethods;
  profiler: Profiler | null;
}

export interface RuntimeOptions {
  bus?: Bus;
  env?: EnvMethods;
  profiler?: Profiler | null;
  enableProfiler?: boolean;
  getProfilerMemory?: () => ProfilerMemory;
}
