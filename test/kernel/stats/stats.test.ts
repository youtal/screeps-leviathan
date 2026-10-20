/**
 * 文件摘要：kernel.stats 的单元测试，以记录型写入器驱动。
 * 覆盖：窗口聚合（平均、最大、最小、计数）；满 STATS_INTERVAL 个 tick 写出到第 50 页，g 为窗口结束的 tick；
 * 正文字段与 stats 设计第 3 节一致；超限时截短重试一次，仍超限则放弃并告警；写出后开始新窗口。
 */
import type { PageWriter, SubmitResult } from '@/kernel/segments';
import { STATS_INTERVAL, STATS_PAGE, type StatsSnapshot, type StatsTick, createStats } from '@/kernel/stats';

/**
 * @description 创建记录型写入器：按给定结果序列返回 submit 的结果。
 * @param results submit 的返回值序列，用尽后为 queued。
 * @returns 写入器与提交记录。
 */
const recorder = (results: SubmitResult[] = []) => {
  const submits: { page: number; g: number; body: string }[] = [];
  const writer: PageWriter = {
    /**
     * @description 记录提交。
     * @param page 页号。
     * @param batch 批次。
     * @param body 正文。
     * @returns 预置结果。
     */
    submit: (page, batch, body) => { submits.push({ page, g: batch.g, body }); return results.shift() ?? 'queued'; },
    /**
     * @description 待写页数。
     * @returns 0。
     */
    pending: () => 0,
  };
  return { writer, submits };
};

const SNAPSHOT: StatsSnapshot = {
  release: '0.1.11', mode: 'NORMAL', top: [['mining:W1N1:a', 0.4219]], down: ['lab'], paused: ['market'],
  memory: { total: 100, spaces: { sys: 10, part: 90, rooms: 0, creeps: 0, flags: 0 } }, segPending: 1,
};

/**
 * @description 生成第 i 个 tick 的指标。
 * @param i 序号，从 1 开始。
 * @returns 指标。
 */
const tick = (i: number): StatsTick => ({
  time: 1000 + i, cpu: i, budget: 21.5, reserve: 2.15,
  tiers: { survival: 0.5, economy: i, maintenance: 0, planning: 0 }, admitted: 2, rejected: i % 2,
  bucket: 9000 + i, health: i === 3 ? 'degraded' : 'ok',
});

test('满一个窗口写出摘要到第 50 页，字段与设计一致；之后开始新窗口', () => {
  const { writer, submits } = recorder();
  const stats = createStats({ writer, warn: () => undefined });
  let snapshots = 0;
  stats.breaker();
  for (let i = 1; i <= STATS_INTERVAL; i += 1) stats.record(tick(i), () => { snapshots += 1; return SNAPSHOT; });
  expect(snapshots).toBe(1);
  expect(submits.map((s) => [s.page, s.g])).toEqual([[STATS_PAGE, 1000 + STATS_INTERVAL]]);
  const n = STATS_INTERVAL;
  const avg = (n + 1) / 2;
  expect(JSON.parse(submits[0].body)).toEqual({
    t: 1000 + n, n, release: '0.1.11', mode: 'NORMAL', health: { ok: n - 1, degraded: 1, paused: 0 },
    cpu: { avg, max: n, b: 21.5, r: 2.15, tiers: { survival: 0.5, economy: avg, maintenance: 0, planning: 0 } },
    admit: { admitted: 2 * n, skipped: n / 2 }, bucket: { min: 9001, last: 9000 + n },
    top: [['mining:W1N1:a', 0.42]], breakers: 1, down: ['lab'], paused: ['market'],
    memory: SNAPSHOT.memory, segPending: 1,
  });
  for (let i = 1; i < STATS_INTERVAL; i += 1) stats.record(tick(i), () => SNAPSHOT);
  expect(submits).toHaveLength(1);
  stats.record(tick(STATS_INTERVAL), () => SNAPSHOT);
  expect(JSON.parse(submits[1].body).breakers).toBe(0);
});

test('超限时截短列表重试一次；仍超限则放弃并告警', () => {
  const warnings: string[] = [];
  const first = recorder(['too-large']);
  const stats = createStats({ writer: first.writer, warn: (m) => warnings.push(m) });
  for (let i = 1; i <= STATS_INTERVAL; i += 1) stats.record(tick(i), () => SNAPSHOT);
  expect(first.submits).toHaveLength(2);
  expect(JSON.parse(first.submits[1].body).top).toEqual([]);
  expect(warnings).toEqual([]);
  const second = recorder(['too-large', 'too-large']);
  const failing = createStats({ writer: second.writer, warn: (m) => warnings.push(m) });
  for (let i = 1; i <= STATS_INTERVAL; i += 1) failing.record(tick(i), () => SNAPSHOT);
  expect(warnings).toEqual([`统计窗口（tick ${1000 + STATS_INTERVAL}）截短后仍超过单页上限，已放弃`]);
});
