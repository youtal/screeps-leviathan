/**
 * 文件摘要：CPU 分层与预算的注入接口（contracts 层，设计见 docs/design/contracts/README.md 第 4 节，
 * 准入与预算规则见架构设计 5.2、5.3）。
 *
 * kernel.cpu 实现 CpuBudget 并按进程注入；模块用它分片执行长计算。准入判定在 kernel 内部完成，不经此接口。
 * 本文件只含类型声明，没有运行时代码。
 */

/** CPU 层级，按准入优先级从高到低：生存、经济、维护、规划。 */
export type Tier = 'survival' | 'economy' | 'maintenance' | 'planning';

/** 绑定到一个进程的 CPU 预算视图。 */
export interface CpuBudget {
  /** 进程所属的层级。 */
  readonly tier: Tier;
  /** 本进程本 tick 剩余可用的 CPU。 */
  remaining(): number;
  /** 长计算每批检查一次；返回 true 时保存游标并结束本 tick 的计算。 */
  shouldYield(): boolean;
}
