/**
 * 文件摘要：运营模式与启动判定结果的只读视图（contracts 层，设计见 docs/design/contracts/README.md 第 6.1 节，
 * 架构设计 11.2 模式集合）。
 *
 * app.boot 写入判定结果，kernel 把只读视图注入给所有模块。本文件是 contracts 依赖图中的叶子，不导入其他文件；
 * 只含类型声明，没有运行时代码。
 */

/** 运营模式，含义见架构设计 11.2。 */
export type BootMode =
  | "NORMAL"
  | "RECOVERY"
  | "FRESH_START"
  | "TAKEOVER"
  | "SELF_ADOPT"
  | "SHARD_SEED"
  | "STRANDED"
  | "DORMANT"
  | "AMBIGUOUS";

/** 判定证据的强度：强证据、中证据（架构设计 11.4–11.8）。 */
export type Strength = "strong" | "medium";

/** 当前启动判定结果的只读视图。 */
export interface BootModeView {
  readonly mode: BootMode;
  readonly strength: Strength;
  /** 进入该模式的 tick。 */
  readonly since: number;
}
