interface Memory {
  profiler: ProfilerMemory;
}

interface ProfilerMemory {
  data: { [name: string]: ProfilerData };
  start?: number;
  showMore?: boolean;
  total: number;
}

interface ProfilerData {
  calls: number;
  time: number;
}

interface Profiler {
  init(): void;
  start(): void;
  stop(): void;
  clear(): void;
  reset(): void;
  status(): void;
  output(): void;
  toString(): string;
  showMore(): void;
  showLess(): void;
}

declare const __PROFILER_ENABLED__: boolean;
