/**
 * 文件摘要：声明 Profiler 的公共控制接口、创建上下文和持久化数据结构。
 *
 * 类型声明只约束模块边界，不生成运行时代码；实现位于 createProfiler.ts 和
 * memory.ts。
 *
 * 本模块位于 core/profiler 的类型边界：Framework 与 Runtime 依赖这里的协议创建和持有
 * Profiler，插件只通过 context.profiler 使用它。所有成员都是编译期声明，打包产物中
 * 会被完全擦除（文件末尾统一 `export` 的也是 interface/type，不产生运行时代码）。
 */
import type { HasWrap, EnvContext } from '@/core/runtime/types';

/**
 * Profiler 对外暴露的能力。
 *
 * 它既可以作为 HasWrap 提供函数包裹，也可以在运行时开关、重置和输出报告。
 * 这里没有暴露内部 memory accessor，调用方只能通过这些受控方法操作统计器。
 *
 * wrap 复用 runtime 的 HasWrap 协议，因此只依赖“能包裹函数”的调用方无需引入完整
 * Profiler 类型；report 的 detailed 参数目前是占位，filter 为空串时输出全量报告。
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
 *
 * getMemory 是访问器而不是快照：Profiler 每次统计操作都会重新调用它，因此宿主可以在
 * 运行期切换命名空间。enable 只是初始值，运行期的 enable()/disable() 只改 Profiler
 * 闭包内的变量，不会回写本对象。markMemoryDirty 省略时表示统计不需要写回登记。
 */
interface ProfilerContext extends EnvContext {
  getMemory: () => ProfilerMemory;
  /** 持久化管理器的显式标脏回调；仅存于调用者闭包的统计可省略。 */
  markMemoryDirty?: () => void;
  enable: boolean;
}

/**
 * 单个 label 的累计统计记录。
 *
 * totalTime 包含子调用耗时；selfTime 会扣除被 profiler 包裹的子调用耗时；
 * calls 记录该 label 被执行的次数。
 *
 * 名字沿用 Profiler 领域内的“一次统计记录”，在本模块内会遮蔽 TypeScript 内置的
 * Record 工具类型，使用处（memory.ts）需要的是这个结构。时间单位是 CPU（两次
 * `Game.cpu.getUsed()` 的差值），不是现实世界毫秒；calls 统计所有取得样本并写入
 * 成功的调用，包含业务抛错但采样完整的调用，因此不能用它推导业务成功次数。
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
 * 它被 FrameworkState.profiler 引用，会整体参与 JSON.stringify，因此只能包含普通
 * 可序列化值；内存占用与 label 数量成正比，与调用次数无关。
 */
interface ProfilerMemory {
  [key: string]: Record;
}

export { Profiler, ProfilerContext, Record, ProfilerMemory };
