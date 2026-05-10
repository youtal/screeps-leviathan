import { Record, ProfilerMemory } from './types';
import { createLog } from '@/utils';

export const createMemoryAccessor = (
  getMemory: () => ProfilerMemory,
  log: ReturnType<typeof createLog>
) => {
  const memory = getMemory();
  if (!memory) {
    log.error('无法获取 Profiler 内存');
    return null;
  }
  const get = (key: string): Record => {
    if (!memory[key]) return { totalTime: 0, selfTime: 0, calls: 0 };
    return memory[key];
  };
  const getAll = (): ProfilerMemory => memory;
  const update = (key: string, _selfTime: number, _totalTime: number) => {
    if (!memory[key]) {
      memory[key] = { totalTime: 0, selfTime: 0, calls: 0 };
    }
    memory[key].totalTime += _totalTime;
    memory[key].selfTime += _selfTime;
    memory[key].calls += 1;
  };
  const clear = () => {
    for (const key in memory) {
      delete memory[key];
    }
  };
  return { get, update, clear, getAll };
};
