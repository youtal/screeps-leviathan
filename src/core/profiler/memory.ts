import type { Record, ProfilerMemory } from './types';
import { createLog } from '@/utils/console';

/**
 * 创建 Profiler Memory 访问器。
 *
 * 这个函数把对原始 ProfilerMemory 对象的读写收敛到一组小方法里：
 * - get：读取某个 label，不存在时返回空记录。
 * - update：累加某次调用的耗时。
 * - clear：清空全部 profiler 数据。
 * - getAll：返回完整 memory，用于 report。
 *
 * 如果 getMemory 无法返回有效对象，则返回 null，让 createProfiler 中止创建。
 */
export const createMemoryAccessor = (
  getMemory: () => ProfilerMemory,
  log: ReturnType<typeof createLog>
) => {
  // TODO(framework-memory): framework 提供跨 tick 的 Memory 映射后，改由该映射
  // 提供稳定引用；在此之前此访问器仍可能持有上一 tick 的 Memory 对象。
  const memory = getMemory();
  if (!memory) {
    log.error('无法获取 Profiler 内存');
    return null;
  }

  /**
   * 读取单个 label 的统计记录。
   *
   * 不直接写入默认记录，是为了让只读 report/filter 不改变 memory 内容。
   */
  const get = (key: string): Record => {
    if (!memory[key]) return { totalTime: 0, selfTime: 0, calls: 0 };
    return memory[key];
  };

  /**
   * 返回原始 memory 引用。
   *
   * report 会基于它做 Object.entries 和排序；调用方不应在外部长期持有它。
   */
  const getAll = (): ProfilerMemory => memory;

  /**
   * 累加一次调用的 profiler 数据。
   *
   * 第一次看到某个 label 时先初始化记录，再分别累加 total/self/calls。
   */
  const update = (key: string, _selfTime: number, _totalTime: number) => {
    if (!memory[key]) {
      memory[key] = { totalTime: 0, selfTime: 0, calls: 0 };
    }
    memory[key].totalTime += _totalTime;
    memory[key].selfTime += _selfTime;
    memory[key].calls += 1;
  };

  /**
   * 原地清空 memory。
   *
   * 不替换整个对象，是为了保留 Memory.profiler 的引用稳定性。
   */
  const clear = () => {
    for (const key in memory) {
      delete memory[key];
    }
  };
  return { get, update, clear, getAll };
};
