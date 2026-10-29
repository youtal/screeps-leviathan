/**
 * 文件摘要：基准测试运行器纯函数（scripts/bench/lib.ts）的单元测试。
 * 覆盖：参数解析与容差校验；构建上下文白名单只含测试目录且场景目录换成 bench 场景；从混杂输出中提取最后一行结果与结构校验；
 * 中位数与分位数、堆统计缺失；与基准比较的各种结论与失败条件（判定取 10% 分位数）；报告文本。
 */
import {
  BENCH_INPUTS, DEFAULT_TOLERANCE, RESULT_PREFIX, compare, extractResult, formatReport, parseBenchArgs, summarize,
} from '../../scripts/bench/lib.ts';
import type { RawResult, Summary } from '../../scripts/bench/lib.ts';

const env = { node: 'v24.21.0', engine: '4.3.2' };

/**
 * @description 构造原始结果。
 * @param records 用例记录。
 * @returns 原始结果。
 */
const raw = (records: RawResult['records']): RawResult => ({ env, ticks: 5, records });

test('参数：缺省容差，--update 与 --tolerance', () => {
  expect(parseBenchArgs([])).toEqual({ update: false, tolerance: DEFAULT_TOLERANCE });
  expect(parseBenchArgs(['--update', '--tolerance', '0.5'])).toEqual({ update: true, tolerance: 0.5 });
  expect(() => parseBenchArgs(['--tolerance=-1'])).toThrow('容差不合法');
  expect(() => parseBenchArgs(['--tolerance', 'x'])).toThrow('用法');
  expect(() => parseBenchArgs(['--only', 'a'])).toThrow('用法');
  expect(() => parseBenchArgs(['extra'])).toThrow('用法');
});

test('构建上下文只取自测试目录，场景目录换成 bench 场景', () => {
  for (const [source] of BENCH_INPUTS) expect(source.startsWith('test/scenarios/') || source.startsWith('test/bench/')).toBe(true);
  expect(BENCH_INPUTS.find(([, target]) => target === 'scenarios')?.[0]).toBe('test/bench/scenarios');
});

test('从混杂输出中提取最后一行结果，并校验结构', () => {
  const first = raw([{ name: 'a', batch: 1, cpu: [1], heap: [null], work: 3 }]);
  const last = raw([{ name: 'b', batch: 2, cpu: [2], heap: [0], work: 4 }]);
  const stdout = `log\n${RESULT_PREFIX}${JSON.stringify(first)}\nmore\n${RESULT_PREFIX}${JSON.stringify(last)}\nPASS: bench\n`;
  expect(extractResult(stdout)).toEqual(last);
  expect(() => extractResult('PASS: bench')).toThrow('没有基准结果');
  expect(() => extractResult(`${RESULT_PREFIX}{"records":[]}`)).toThrow('结构不符合预期');
  expect(() => extractResult(`${RESULT_PREFIX}${JSON.stringify(raw([{ name: 'a', batch: 1, cpu: [], heap: [], work: 1 }]))}`))
    .toThrow('用例记录不完整');
});

test('汇总：中位数、分位数与堆统计缺失', () => {
  const s = summarize(raw([
    { name: 'a', batch: 4, cpu: [5, 1, 3, 2, 4], heap: [null, 8, 0, 16, null], work: 9 },
    { name: 'b', batch: 1, cpu: [2], heap: [null], work: 1 },
  ]));
  expect(s.cases.a).toEqual({ batch: 4, samples: 5, cpu: { median: 3, p10: 1.4, p90: 4.6 }, heap: 8, work: 9 });
  expect(s.cases.b.heap).toBeNull();
  expect(s.env).toEqual(env);
  expect(() => summarize(raw([
    { name: 'a', batch: 1, cpu: [1], heap: [null], work: 1 }, { name: 'a', batch: 1, cpu: [1], heap: [null], work: 1 },
  ]))).toThrow('用例名重复');
});

test('比较：各种结论，工作量改变与回归判为失败', () => {
  // 判定取 10% 分位数：中位数故意设为与之不同的值，确认比较不看中位数。
  const caseOf = (p10: number, work: number) => ({ batch: 1, samples: 1, cpu: { median: p10 * 3, p10, p90: p10 * 4 }, heap: null, work });
  const baseline: Summary = { env, cases: { same: caseOf(1, 5), slow: caseOf(1, 5), fast: caseOf(1, 5), work: caseOf(1, 5), gone: caseOf(1, 1) } };
  const current: Summary = { env, cases: { same: caseOf(1.2, 5), slow: caseOf(1.31, 5), fast: caseOf(0.7, 5), work: caseOf(1, 6), added: caseOf(1, 1) } };
  const { rows, failed } = compare(current, baseline, 0.3);
  expect(rows.map((r) => [r.name, r.status])).toEqual([
    ['same', 'ok'], ['slow', 'slower'], ['fast', 'faster'], ['work', 'work-changed'], ['added', 'new'], ['gone', 'missing'],
  ]);
  expect(failed).toBe(true);
  expect(compare({ env, cases: { same: caseOf(1.2, 5), fast: caseOf(0.5, 5) } }, baseline, 0.3).failed).toBe(false);
  const fresh = compare(current, null, 0.3);
  expect([fresh.failed, fresh.rows.every((r) => r.status === 'new')]).toEqual([false, true]);
});

test('报告包含运行环境与每个用例一行', () => {
  const s = summarize(raw([{ name: 'grid.bfs/empty', batch: 8, cpu: [0.012345], heap: [0], work: 2500 }]));
  const text = formatReport(compare(s, null, 0.3).rows, s, null);
  expect(text).toContain('Node v24.21.0，引擎 4.3.2；没有基准文件');
  expect(text).toContain('grid.bfs/empty | new | 0.01235 | — | — | 0.01235 | 0 | 2500 | —');
});
