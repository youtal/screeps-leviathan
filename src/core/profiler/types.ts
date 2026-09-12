/**
 * 文件摘要：保存 Profiler 装配上下文与统计数据；公共观测能力由 contracts 发布。
 * 仅维护模块内部类型及契约兼容出口，不创建运行时状态或调用宿主。
 */
import type { EnvContext } from '@/contracts/environment';
export type { Profiler } from '@/contracts/profiler';
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
export interface ProfilerContext extends EnvContext {
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
export type Record = {
  totalTime: number;
  selfTime: number;
  calls: number;
};

/**
 * Profiler 持久化数据结构。
 *
 * key 是 wrap 时传入的 label，value 是该 label 的累计耗时记录。
 * 宿主可选择 heap 或存储，统计数据只包含普通
 * 可序列化值；内存占用与 label 数量成正比，与调用次数无关。
 */
export interface ProfilerMemory {
  [key: string]: Record;
}
