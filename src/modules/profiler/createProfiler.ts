import { ProfilerContext, Profiler } from './types';
import { createMemoryAccessor } from './memory';
import { Wrap } from '@/utils';

export const createProfiler = (context: ProfilerContext): Profiler => {
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

  const usedLabel: Record<string, boolean> = {};
  const stack: { label: string; start: number; childTime: number }[] = [];

  //核心实现，用于包裹函数
  const wrap: Wrap = <T extends (...args: any[]) => any>(label, fn: T) => {
    if (!enableProfiler) return fn;
    if (usedLabel[label]) {
      log.warn(`Profiler: label "${label}" 已被使用，未执行包裹`);
      return fn;
    }
    usedLabel[label] = true;
    return ((...args: any[]) => {
      //将本层调用信息入栈
      const start = getGame().cpu.getUsed();
      stack.push({ label, start, childTime: 0 });

      //执行被包裹的函数
      const result: ReturnType<T> = fn(...args);

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

      //返回结果
      return result;
    }) as T;
  };

  //TODO: 实现细节输出与一般输出
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
