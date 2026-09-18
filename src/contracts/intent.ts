/**
 * 文件摘要
 *
 * 模块角色：contracts 中的动作提交协议，连接业务插件与框架的动作仲裁、CPU 检查。
 *
 * 主要功能：声明 GameIntent、执行回执 IntentReceipt 和 CpuBudget。
 *
 * 实现过程：意图携带对象、通道、优先级、附加锁和执行回调；回执用 tick 与序号关联提交，
 * 以状态和可选返回码描述处理结果；预算接口提供剩余量查询与准入判断。
 *
 * 技术要点：回执表示 API 提交结果，不能代替下一 tick 的事实核验；执行回调只供本 tick 使用。
 * 文件只规定数据形状，不排队、不竞争锁，也不调用游戏动作。
 */
/** 多个通道或锁可以一起竞争，避免将游戏动作兼容规则硬编码进 Kernel。 */
export interface GameIntent {
  /** 与 channel 共同形成对象动作的互斥键；通常传入游戏对象 ID。 */
  subjectId: string;
  /** 业务定义动作通道；内核不推断 Screeps 各类动作之间的兼容关系。 */
  channel: string;
  /** 大值优先，相同值按本 tick 提交次序；默认 0。 */
  priority?: number;
  /** 额外的全局独占锁，可表达跨对象竞争；所有锁必须同时获得。 */
  locks?: readonly string[];
  /** 仅胜者在 commit 中同步调用；不能保存到 Memory，也不能跨 tick 复用 Game 对象。 */
  execute(): ScreepsReturnCode;
  /** 可选业务说明，保留在候选中；当前回执不复制此字段。 */
  describe?: string;
}

/** API 提交结果，不是下一 tick 的事实确认；accepted 也可能带非 OK 返回码。 */
export interface IntentReceipt {
  /** 从 0 开始的本 tick 提交序号；跨 tick 识别时需同时使用 tick。 */
  id: number;
  tick: number;
  pluginId: string;
  subjectId: string;
  channel: string;
  /** accepted 已调用；rejected 未胜出/插件失效；failed 抛错；deferred 因 CPU 暂缓。 */
  status: 'accepted' | 'rejected' | 'failed' | 'deferred';
  reason?: string;
  apiResult?: ScreepsReturnCode;
}

/** 实时采样预算，不预占 CPU；准入后运行时间仍由插件自行控制。 */
export interface CpuBudget {
  remaining(): number;
  admit(critical?: boolean): boolean;
}
