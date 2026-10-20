/**
 * 文件摘要：kernel.stats，kernel 运行指标的窗口聚合与统计 segment 写出（设计见 docs/design/kernel/stats.md，架构设计 5.8、6.8）。
 *
 * 所属位置：src/kernel/stats/，kernel 内部模块，只由 kernel.lifecycle 在收尾阶段调用（Memory 提交之后、segment 提交之前）。
 * 每 tick 调用 record 累计一个窗口；窗口满 STATS_INTERVAL 个 tick 时向快照函数取一次写出时的状态，
 * 拼装一行 JSON，经 segments 的 stats 写入器整页覆盖写入第 50 页（v = 1，g = 窗口结束的 tick）。
 * 只写不读：统计丢失只影响观测，不影响运营。正文超限时依次截短 top、down、paused 后重试一次，仍超限则放弃本窗口并告警。
 * 状态：当前窗口的计数保存在 createStats 的闭包中，只存于 heap；global reset 与软重置后从新窗口开始，未写出的窗口丢失。
 */
import type { Tier } from '@/contracts/cpu';
import type { PageWriter } from '@/kernel/segments';

/** 窗口长度与提交间隔（tick）。 */
export const STATS_INTERVAL = 20;
/** 写出的高耗用进程数。 */
export const STATS_TOP = 20;
/** 统计页号（6.8）与数据版本。 */
export const STATS_PAGE = 50;
export const STATS_VERSION = 1;

/** 一个 tick 的指标，由 lifecycle 在收尾时给出。 */
export interface StatsTick {
  readonly time: number;
  /** 收尾前读取的本 tick 总耗用。 */
  readonly cpu: number;
  readonly budget: number;
  readonly reserve: number;
  /** { [层级]: 本 tick 计量到的耗用 }。 */
  readonly tiers: Readonly<Record<Tier, number>>;
  readonly admitted: number;
  readonly rejected: number;
  readonly bucket: number;
  readonly health: 'ok' | 'degraded' | 'paused';
}

/** 写出时的状态快照，由 lifecycle 按需生成。 */
export interface StatsSnapshot {
  readonly release: string;
  readonly mode: string;
  /** 平滑耗用最高的进程，[进程键, 平滑耗用]，从高到低，最多 STATS_TOP 个。 */
  readonly top: readonly (readonly [string, number])[];
  /** 熔断或初始化失败的模块 id。 */
  readonly down: readonly string[];
  /** 运维暂停（含清单默认暂停）的模块 id。 */
  readonly paused: readonly string[];
  /** Memory 体积；Memory 为 empty 或加载失败时为 null。 */
  readonly memory: { readonly total: number; readonly spaces: Readonly<Record<string, number>> } | null;
  /** segments 中尚未写出的页数。 */
  readonly segPending: number;
}

/** kernel 内部接口。 */
export interface StatsHost {
  /**
   * @description 累计一个 tick；窗口满时写出摘要并开始新窗口。
   * @param tick 本 tick 的指标。
   * @param snapshot 写出时调用一次，生成状态快照。
   * @returns 无返回值。
   */
  record(tick: StatsTick, snapshot: () => StatsSnapshot): void;
  /**
   * @description 记一次熔断，计入当前窗口。
   * @returns 无返回值。
   */
  breaker(): void;
}

/** 创建选项。 */
export interface StatsOptions {
  /** segments 的 stats 写入器（version 为 STATS_VERSION）。 */
  readonly writer: PageWriter;
  /**
   * @description 告警输出。
   * @param message 告警正文。
   * @returns 无返回值。
   */
  warn(message: string): void;
}

/**
 * @description 保留两位小数，减小正文体积。
 * @param value 数值。
 * @returns 四舍五入后的值。
 */
const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * @description 创建 kernel.stats；构造不访问平台。
 * @param options 写入器与告警。
 * @returns 宿主接口。
 */
export const createStats = (options: StatsOptions): StatsHost => {
  // 当前窗口：tick 数、耗用合计与最大值、各层耗用合计、准入与落选合计、bucket 最小值、各健康状态的 tick 数、新增熔断次数。
  let n = 0;
  let cpuSum = 0;
  let cpuMax = 0;
  let tierSum = { survival: 0, economy: 0, maintenance: 0, planning: 0 };
  let admitted = 0;
  let rejected = 0;
  let bucketMin = Number.POSITIVE_INFINITY;
  let health = { ok: 0, degraded: 0, paused: 0 };
  let breakers = 0;

  /**
   * @description 清空窗口。
   * @returns 无返回值。
   */
  const reset = (): void => {
    n = 0; cpuSum = 0; cpuMax = 0; tierSum = { survival: 0, economy: 0, maintenance: 0, planning: 0 };
    admitted = 0; rejected = 0; bucketMin = Number.POSITIVE_INFINITY; health = { ok: 0, degraded: 0, paused: 0 }; breakers = 0;
  };

  /**
   * @description 拼装窗口摘要的正文（stats.md 第 3 节的字段顺序）。
   * @param last 窗口最后一个 tick 的指标。
   * @param s 写出时的状态快照。
   * @param lists 截短后的 top、down、paused。
   * @returns 一行 JSON。
   */
  const body = (last: StatsTick, s: StatsSnapshot,
    lists: { top: readonly (readonly [string, number])[]; down: readonly string[]; paused: readonly string[] }): string =>
    JSON.stringify({
      t: last.time, n, release: s.release, mode: s.mode, health,
      cpu: { avg: round(cpuSum / n), max: round(cpuMax), b: round(last.budget), r: round(last.reserve),
        tiers: { survival: round(tierSum.survival / n), economy: round(tierSum.economy / n),
          maintenance: round(tierSum.maintenance / n), planning: round(tierSum.planning / n) } },
      admit: { admitted, skipped: rejected }, bucket: { min: bucketMin, last: last.bucket },
      top: lists.top.map(([key, cost]) => [key, round(cost)]), breakers, down: lists.down, paused: lists.paused,
      memory: s.memory, segPending: s.segPending,
    });

  /**
   * @description 写出窗口摘要：超限时截短列表重试一次，仍超限则放弃并告警。
   * @param last 窗口最后一个 tick 的指标。
   * @param s 状态快照。
   * @returns 无返回值。
   */
  const flush = (last: StatsTick, s: StatsSnapshot): void => {
    const batch = { g: last.time, i: 0, n: 1 };
    if (options.writer.submit(STATS_PAGE, batch, body(last, s, s)) !== 'too-large') return;
    const result = options.writer.submit(STATS_PAGE, batch, body(last, s, { top: [], down: s.down.slice(0, 10), paused: s.paused.slice(0, 10) }));
    if (result === 'too-large') options.warn(`统计窗口（tick ${last.time}）截短后仍超过单页上限，已放弃`);
  };

  return {
    /**
     * @description 累计一个 tick，语义见 StatsHost.record。
     * @param tick 本 tick 的指标。
     * @param snapshot 写出时的状态快照函数。
     * @returns 无返回值。
     */
    record(tick, snapshot) {
      n += 1;
      cpuSum += tick.cpu;
      if (tick.cpu > cpuMax) cpuMax = tick.cpu;
      tierSum.survival += tick.tiers.survival; tierSum.economy += tick.tiers.economy;
      tierSum.maintenance += tick.tiers.maintenance; tierSum.planning += tick.tiers.planning;
      admitted += tick.admitted;
      rejected += tick.rejected;
      if (tick.bucket < bucketMin) bucketMin = tick.bucket;
      health[tick.health] += 1;
      if (n < STATS_INTERVAL) return;
      try { flush(tick, snapshot()); } finally { reset(); }
    },
    /**
     * @description 记一次熔断。
     * @returns 无返回值。
     */
    breaker() { breakers += 1; },
  };
};
