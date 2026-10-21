/**
 * 文件摘要：CPU 分层与预算的注入接口（contracts 层，设计见 docs/design/contracts/README.md 第 4 节，
 * 准入与预算规则见架构设计 5.2、5.3）。
 *
 * kernel.cpu 实现 CpuBudget 并按进程注入；模块用它分片执行长计算。准入判定在 kernel 内部完成，不经此接口。
 * 本文件只含类型声明，没有运行时代码。
 */

/** CPU 层级，按准入优先级从高到低：生存、经济、维护、规划。 */
export type Tier = 'survival' | 'economy' | 'maintenance' | 'planning';

/**
 * 进程所在层的 CPU 预算视图：同层的进程共用一个份额（cpu 设计第 4 节）。
 * remaining 不扣除本 tick 其他已准入、尚未运行的同层进程的预计耗用，shouldYield 只保证调用方自身不越过本层上限（审计 S-17）。
 */
export interface CpuBudget {
  /** 进程所属的层级。 */
  readonly tier: Tier;
  /**
   * @description 查询本进程所在层本 tick 剩余可用的 CPU（同层进程共用），用于决定还能处理多少工作。
   * @returns 本层上限减去当前读数；已用尽时为 0 或负数。
   */
  remaining(): number;
  /**
   * @description 长计算每处理一批检查一次，判断是否应让出本 tick。
   * @returns 为 true 时调用方保存游标并结束本 tick 的计算，下一 tick 从游标继续。
   */
  shouldYield(): boolean;
}
