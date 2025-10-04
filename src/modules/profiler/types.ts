import { HasWrap, EnvContext } from '@/utils';

interface Profiler extends HasWrap {
  enable(): void;
  disable(): void;
  reset(): void;
  report(detailed?: boolean, filter?: string): void;
}

interface ProfilerContext extends EnvContext {
  getMemory: () => ProfilerMemory;
  enable: boolean;
}

type Record = {
  totalTime: number;
  selfTime: number;
  calls: number;
};

interface ProfilerMemory {
  [key: string]: Record;
}

export { Profiler, ProfilerContext, Record, ProfilerMemory };
