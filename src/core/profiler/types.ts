import type { HasWrap, EnvContext } from '@/core/runtime/types';

/**
 * Profiler 对外暴露的能力。
 *
 * 它既可以作为 HasWrap 提供函数包裹，也可以在运行时开关、重置和输出报告。
 * 这里没有暴露内部 memory accessor，调用方只能通过这些受控方法操作统计器。
 */
interface Profiler extends HasWrap {
  enable(): void;
  disable(): void;
  reset(): void;
  report(detailed?: boolean, filter?: string): void;
}

/**
 * 创建 Profiler 所需的上下文。
 *
 * env 提供日志和 Game.cpu.getUsed 访问；getMemory 决定统计结果写入哪里；
 * enable 控制 profiler 初始是否采样。
 */
interface ProfilerContext extends EnvContext {
  getMemory: () => ProfilerMemory;
  enable: boolean;
}

/**
 * 单个 label 的累计统计记录。
 *
 * totalTime 包含子调用耗时；selfTime 会扣除被 profiler 包裹的子调用耗时；
 * calls 记录该 label 被执行的次数。
 */
type Record = {
  totalTime: number;
  selfTime: number;
  calls: number;
};

/**
 * Profiler 持久化数据结构。
 *
 * key 是 wrap 时传入的 label，value 是该 label 的累计耗时记录。
 */
interface ProfilerMemory {
  [key: string]: Record;
}

export { Profiler, ProfilerContext, Record, ProfilerMemory };
