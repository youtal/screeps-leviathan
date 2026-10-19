/**
 * 文件摘要：kernel.profiler，实现 Measure 契约，按标签聚合 CPU 耗用（设计见 docs/design/kernel/profiler.md）。
 *
 * 所属位置：src/kernel/profiler/，kernel 内部模块，零依赖：CPU 读数由装配方注入（游戏中为 Game.cpu.getUsed）；
 * 不写日志，不访问 Memory 与 segment。数据只放在 heap，global reset 后重新积累。
 * 状态（均在 createProfiler 的闭包中）：
 * - records：{ [标签 '<作用域>.<op>']: 该标签的聚合记录 }，数量不超过 maxLabels；
 * - 每个作用域另有 { [op]: 同一记录 } 的缓存，end 不必每次拼接标签；
 * - overflow：因超过标签上限而丢弃的计时次数，累计到实例销毁。
 * 成本：begin/end 各调用一次 cpuUsed；beginTick 的结算与标签数成正比，每 tick 一次。
 */
import type { Measure } from '../../contracts/log';

/** 平滑系数，约等于近 10 tick 的窗口。 */
export const PROFILE_ALPHA = 0.1;
/** 默认的标签数量上限。 */
export const PROFILE_MAX_LABELS = 500;

/** 创建 profiler 的选项。 */
export interface ProfilerOptions {
  /** 当前已用 CPU，游戏中为 () => Game.cpu.getUsed()。 */
  readonly cpuUsed: () => number;
  /** 标签数量上限，默认 PROFILE_MAX_LABELS。 */
  readonly maxLabels?: number;
}

/** 一个标签的只读统计。 */
export interface ProfileEntry {
  /** 计时标签 `<作用域>.<op>`。 */
  readonly label: string;
  /** 上一个完整 tick 的累计耗用。 */
  readonly tick: number;
  /** 上一个完整 tick 的调用次数。 */
  readonly calls: number;
  /** 每 tick 耗用的指数平滑值。 */
  readonly average: number;
}

/** 计时聚合器。 */
export interface Profiler {
  /**
   * @description 派生一个作用域的 Measure，计时标签为 `${prefix}.${op}`；同一前缀多次调用得到彼此独立、共享标签记录的对象。
   * @param prefix 作用域，通常为模块 ID 或进程键。
   * @returns 绑定该作用域的 Measure。
   */
  scope(prefix: string): Measure;
  /**
   * @description 每 tick 开始时调用：结算上一 tick（更新平滑值，保存上一 tick 累计与次数），并清零本 tick 累计。
   * @returns 无返回值。
   */
  beginTick(): void;
  /**
   * @description 生成全部标签的只读统计。
   * @returns 新数组，修改它不影响内部记录。
   */
  snapshot(): readonly ProfileEntry[];
  /** 因超过标签上限而丢弃的计时次数（累计）。 */
  readonly overflow: number;
}

/** 一个标签的内部聚合记录；字段在构造时按固定顺序初始化，保持对象形状稳定。 */
interface LabelRecord {
  readonly label: string;
  /** 本 tick 累计耗用。 */
  current: number;
  /** 本 tick 调用次数。 */
  currentCalls: number;
  /** 上一 tick 累计耗用。 */
  last: number;
  /** 上一 tick 调用次数。 */
  lastCalls: number;
  /** 平滑值；尚未结算过时为 undefined。 */
  average: number | undefined;
}

/**
 * @description 创建 profiler 实例。
 * @param options CPU 读数与标签数量上限。
 * @returns profiler 实例。
 */
export const createProfiler = (options: ProfilerOptions): Profiler => {
  const maxLabels = options.maxLabels ?? PROFILE_MAX_LABELS;
  // { [标签]: 聚合记录 }。
  const records = new Map<string, LabelRecord>();
  let overflow = 0;

  /**
   * @description 取得或创建标签记录；已达上限时返回 undefined。
   * @param label 计时标签。
   * @returns 标签记录；超过上限时为 undefined。
   */
  const recordFor = (label: string): LabelRecord | undefined => {
    const existing = records.get(label);
    if (existing) return existing;
    if (records.size >= maxLabels) return undefined;
    const created: LabelRecord = { label, current: 0, currentCalls: 0, last: 0, lastCalls: 0, average: undefined };
    records.set(label, created);
    return created;
  };

  return {
    /**
     * @description 派生作用域 Measure，语义见 Profiler.scope。
     * @param prefix 作用域。
     * @returns 绑定该作用域的 Measure。
     */
    scope(prefix) {
      // { [op]: 对应标签的记录 }；未命中时才拼接标签并查询全局表。
      const local = new Map<string, LabelRecord>();
      return {
        /**
         * @description 开始一次计时。
         * @returns 开始时的 CPU 读数。
         */
        begin: () => options.cpuUsed(),
        /**
         * @description 结束一次计时并计入标签；超过标签上限时丢弃并累加 overflow。
         * @param op 操作名，取自有限集合。
         * @param start begin 返回的开始读数。
         * @returns 无返回值。
         */
        end(op, start) {
          let record = local.get(op);
          if (!record) {
            record = recordFor(`${prefix}.${op}`);
            if (!record) { overflow += 1; return; }
            local.set(op, record);
          }
          record.current += options.cpuUsed() - start;
          record.currentCalls += 1;
        },
      };
    },
    /**
     * @description 结算上一 tick 并清零本 tick 累计，语义见 Profiler.beginTick。
     * @returns 无返回值。
     */
    beginTick() {
      for (const record of records.values()) {
        record.average = record.average === undefined
          ? record.current
          : record.average * (1 - PROFILE_ALPHA) + record.current * PROFILE_ALPHA;
        record.last = record.current;
        record.lastCalls = record.currentCalls;
        record.current = 0;
        record.currentCalls = 0;
      }
    },
    /**
     * @description 生成只读统计，语义见 Profiler.snapshot。
     * @returns 新数组。
     */
    snapshot() {
      const entries: ProfileEntry[] = [];
      for (const r of records.values()) {
        entries.push({ label: r.label, tick: r.last, calls: r.lastCalls, average: r.average ?? 0 });
      }
      return entries;
    },
    /**
     * @description 读取丢弃的计时次数。
     * @returns 累计丢弃次数。
     */
    get overflow() { return overflow; },
  };
};
