import type { ProfilerContext, Profiler } from './types';
import { createMemoryAccessor } from './memory';
import type { Wrap } from '@/core/runtime/types';

/**
 * 创建性能统计器。
 *
 * Profiler 的核心思路是用 wrap 包裹函数，在函数执行前后读取
 * Game.cpu.getUsed，并把结果累计到 ProfilerMemory 中。
 *
 * 它支持嵌套调用：子调用耗时会累加到父调用的 childTime，父调用的
 * selfTime 会扣除这部分时间，从而区分“自身耗时”和“包含子调用的总耗时”。
 */
export const createProfiler = (context: ProfilerContext): Profiler | null => {
  let { getMemory, enable: enableProfiler } = context;
  const { log, getGame } = context.env;

  const db = createMemoryAccessor(getMemory, log);
  if (!db) {
    log.error('无法创建 Profiler');
    return null;
  }

  //profiler 开关函数
  const enable = () => (enableProfiler = true);
  const disable = () => (enableProfiler = false);
  const reset = () => db.clear();

  /**
   * 已使用的 label 集合。
   *
   * 同一个 label 被重复 wrap 会让统计结果难以理解，因此这里选择拒绝二次包裹，
   * 并返回原函数。若未来需要支持同名函数，可以在 label 层引入模块前缀。
   */
  const usedLabel: Record<string, boolean> = {};

  /**
   * 当前调用栈。
   *
   * 每进入一个被包裹函数就 push 一条记录；finally 中 pop 并计算耗时。
   * childTime 用于记录 profiler 能感知到的子调用耗时。
   */
  const stack: { label: string; start: number; childTime: number }[] = [];

  /**
   * 包裹函数并返回同签名函数。
   *
   * enableProfiler 在执行时判断，而不是 wrap 时判断。这样 enable/disable
   * 可以影响已经包裹过的函数。
   */
  const wrap: Wrap = <T extends (...args: any[]) => any>(
    label: string,
    fn: T
  ) => {
    if (usedLabel[label]) {
      log.warn(`Profiler: label "${label}" 已被使用，未执行包裹`);
      return fn;
    }
    usedLabel[label] = true;
    return ((...args: any[]) => {
      /**
       * 禁用状态下直接执行原函数。
       *
       * 仍然返回 wrapper，是为了让 enable/disable 对已包裹函数即时生效。
       */
      if (!enableProfiler) return fn(...args);

      //将本层调用信息入栈
      const start = getGame().cpu.getUsed();
      stack.push({ label, start, childTime: 0 });

      try {
        //执行被包裹的函数
        return fn(...args);
      } finally {
        /**
         * 使用 finally 保证原函数抛错时也能正确出栈。
         *
         * 这避免一次异常污染整个 profiler 调用栈，后续统计仍然可靠。
         */
        //出栈，并计算时间
        const end = getGame().cpu.getUsed();
        const record = stack.pop()!;
        const totalTime = end - record.start;
        const selfTime = totalTime - record.childTime;

        //记录到Memory
        db.update(record.label, selfTime, totalTime);

        //将本次调用时间加入到上一层的子调用时间中
        if (stack.length > 0) {
          stack[stack.length - 1].childTime += totalTime;
        }
      }
    }) as T;
  };

  /**
   * 输出 profiler 报告。
   *
   * filter 存在时只输出单个 label；否则按 selfTime 降序输出全部记录。
   * detailed 参数目前预留，后续可以用于输出调用树或更细粒度信息。
   */
  const report = (detailed = false, filter = ''): void => {
    if (filter) {
      log.info(`Profiler 报告 (过滤器: ${filter})`);
      const data = db.get(filter);
      log.report(
        `  ${filter} - 总时间: ${data.totalTime}, 自身时间: ${data.selfTime}, 调用次数: ${data.calls}, 平均时间: ${
          data.totalTime / data.calls || 0
        }`
      );
      return;
    }

    const memory = db.getAll();
    const entries = Object.entries(memory);
    //按自身时间排序
    entries.sort((a, b) => b[1].selfTime - a[1].selfTime);

    log.info(`Profiler 报告 (共 ${entries.length} 项)`);
    for (const [label, record] of entries) {
      log.report(
        `  ${label} - 总时间: ${record.totalTime}, 自身时间: ${record.selfTime}, 调用次数: ${record.calls}, 平均时间: ${
          record.totalTime / record.calls || 0
        }`
      );
    }
  };

  return { wrap, enable, disable, reset, report };
};
