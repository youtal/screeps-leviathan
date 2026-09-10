/**
 * 文件摘要：创建可开关的函数级 CPU Profiler，并统计嵌套调用的总耗时与自身耗时。
 *
 * Profiler 以闭包保存开关、标签集合和调用栈，通过 `Game.cpu.getUsed()` 在函数
 * 前后取样。只有启用时才承担取样和 Memory 累加成本；禁用时包装函数直接转调
 * 原函数。统计数据由 memory.ts 提供的访问器统一维护。
 * 包装器和调用栈只驻留 heap，global reset 后重建；累计值从常驻 Memory 命名空间读取。
 * 只测量同步调用区间，不等待 Promise 完成；采样或写入故障不得改变业务返回/抛错行为。
 */
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

  const db = createMemoryAccessor(getMemory, log, context.markMemoryDirty);
  if (!db) {
    log.error('无法创建 Profiler');
    return null;
  }

  /** 运行时开关只修改闭包变量，因此已经创建的 wrapper 会立即响应。 */
  const enable = () => (enableProfiler = true);
  const disable = () => (enableProfiler = false);
  /** 只清累计数据，标签占用和已创建包装器保留，不影响它们后续继续统计。 */
  const reset = () => db.clear();

  /**
   * 已使用的 label 集合。
   *
   * 同一个 label 被重复 wrap 会让统计结果难以理解，因此这里选择拒绝二次包裹，
   * 并返回原函数。若未来需要支持同名函数，可以在 label 层引入模块前缀。
   */
  // 无原型对象允许 constructor 等普通字符串作为标签，不误命中继承属性。
  const usedLabel: Record<string, boolean> = Object.create(null);

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
   * T 与末尾 as T 保持参数/返回签名；普通 function 的动态 this 配合 apply 保留方法语义。
   * 包装层的 any 只用于转发未知参数，不转换业务输入或吞并业务异常。
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
    return function (this: unknown, ...args: any[]) {
      /**
       * 禁用状态下直接执行原函数。
       *
       * 仍然返回 wrapper，是为了让 enable/disable 对已包裹函数即时生效。
       */
      if (!enableProfiler) return fn.apply(this, args);

      /** 记录本层起点并入栈，使嵌套 wrapper 能把耗时归入父层 childTime。 */
      let start: number;
      try {
        start = getGame().cpu.getUsed();
      } catch {
        // 取样故障只关闭本次统计，原始函数仍按相同 this/参数执行。
        return fn.apply(this, args);
      }
      stack.push({ label, start, childTime: 0 });

      try {
        // 原函数正常返回或抛错都进入 finally，故失败调用也计入成功完成采样的统计。
        return fn.apply(this, args);
      } finally {
        /**
         * 使用 finally 保证原函数抛错时也能正确出栈。
         *
         * 先出栈再采样，采样本身失败也不会遗留栈帧；失败样本不写入 Memory。
         */
        /** 非空断言对应前面的同步 push；total 是包含子调用的区间，self 扣除已记录子区间。 */
        const record = stack.pop()!;
        try {
          const totalTime = getGame().cpu.getUsed() - record.start;
          const selfTime = totalTime - record.childTime;
          // 先恢复父调用计时关系，Memory 写入失败不能污染嵌套栈。
          if (stack.length > 0) stack[stack.length - 1].childTime += totalTime;
          db.update(record.label, selfTime, totalTime);
        } catch {
          // 观测操作不能覆盖业务返回值或原始异常，下一次调用可以继续取样。
        }
      }
    } as T;
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
    /** 默认按自身耗时降序排列，优先暴露最值得直接优化的函数。 */
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
