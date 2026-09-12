/**
 * 文件摘要：封装 Profiler 统计容器的读取、累加与清空，属于本模块内部模型的访问层。
 * 输入为宿主 getMemory、Logger 和可选标脏回调，不直接读写 RawMemory 或全局 Memory。
 * 每次操作重取容器并原地更新；heap 生命周期由宿主控制，Framework 默认在 reset 后丢失统计。
 * 注入持久化存储时由宿主负责标脏及提交，访问器自身不缓存第二份引用、不序列化。
 */
import type { Record, ProfilerMemory } from './types';
import type { Logger } from '@/contracts/logging';

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
 *
 * 参数约定：getMemory 必须同步返回当前命名空间（可能为空值）；markDirty 在每次原地修改
 * 之前调用，默认空实现用于纯 heap 统计，接入持久化管理器时必须传入真实标脏回调。
 */
export const createMemoryAccessor = (
  getMemory: () => ProfilerMemory,
  log: Logger,
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
   * 用 hasOwnProperty 而不是真值判断，是为了不把原型链上的 constructor/toString 等
   * 成员当成统计记录返回；代价是每次读取多一次自有属性检查。
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
   * report 会基于它做 Object.entries 和排序；由于 getMemory 每次求值，这个引用只在
   * 宿主下一次迁移命名空间前有效，调用方不应在外部长期持有它。
   */
  const getAll = (): ProfilerMemory => getMemory();

  /**
   * 累加一次调用的 profiler 数据。
   *
   * 第一次看到某个 label 时先初始化记录，再分别累加 total/self/calls。
   * 单个样本只有常数次属性读写（O(1)），不产生新对象；记录字段保持数字类型，
   * 因此整体 JSON.stringify 序列化开销与 label 数量成正比，而不是与调用次数成正比。
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
   * 标脏先于删除，避免删除过程中抛错留下“已改但未登记”的状态；标签占用记录保留在
   * Profiler 的 usedLabel 中，因此已创建的 wrapper 会在后续调用里从 0 重新累计。
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
