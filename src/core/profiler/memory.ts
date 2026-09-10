/**
 * 文件摘要：封装 Profiler 对持久化统计对象的读取、累加和清空操作。
 *
 * 每次操作通过 getMemory 定位当前统计命名空间，兼容 Framework 初始化迁移；
 * Framework 的 Memory 在同一 global 生命周期常驻 heap，访问器不自行缓存第二份引用。
 * 更新和清空原地修改当前对象，不自行序列化；写回由宿主或 Framework 统一负责。
 */
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
 * 如果首次 getMemory 返回空值，则返回 null；不承担完整 schema 校验。
 * 访问器抛出的异常由调用方处理，Profiler 的计时路径会隔离这类观测故障。
 */
export const createMemoryAccessor = (
  getMemory: () => ProfilerMemory,
  log: ReturnType<typeof createLog>,
  markDirty: () => void = () => undefined
) => {
  if (!getMemory()) {
    log.error('无法获取 Profiler 内存');
    return null;
  }

  /**
   * 读取单个 label 的统计记录。
   *
   * 不直接写入默认记录，是为了让只读 report/filter 不改变 memory 内容。
   */
  const get = (key: string): Record => {
    const memory = getMemory();
    if (!Object.prototype.hasOwnProperty.call(memory, key))
      return { totalTime: 0, selfTime: 0, calls: 0 };
    return memory[key];
  };

  /**
   * 返回原始 memory 引用。
   *
   * report 会基于它做 Object.entries 和排序；调用方不应在外部长期持有它。
   */
  const getAll = (): ProfilerMemory => getMemory();

  /**
   * 累加一次调用的 profiler 数据。
   *
   * 第一次看到某个 label 时先初始化记录，再分别累加 total/self/calls。
   */
  const update = (key: string, _selfTime: number, _totalTime: number) => {
    // 在任何原地修改之前标脏；后续写入抛错时仍保留保守的待提交状态。
    markDirty();
    const memory = getMemory();
    if (!Object.prototype.hasOwnProperty.call(memory, key)) {
      // 定义自有属性而非触发 __proto__ setter；可枚举以参与 JSON，可配置以支持 reset 删除。
      Object.defineProperty(memory, key, {
        value: { totalTime: 0, selfTime: 0, calls: 0 },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    memory[key].totalTime += _totalTime;
    memory[key].selfTime += _selfTime;
    memory[key].calls += 1;
  };

  /**
   * 原地清空 memory。
   *
   * 不替换当前统计命名空间，以保留本次读取者的引用；成本与标签数线性相关。
   */
  const clear = () => {
    markDirty();
    const memory = getMemory();
    for (const key in memory) {
      delete memory[key];
    }
  };
  return { get, update, clear, getAll };
};
