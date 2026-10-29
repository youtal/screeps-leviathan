/**
 * 文件摘要：基准测试运行器的纯函数实现，供 cli.ts 与单元测试使用。
 *
 * 所属位置：scripts/bench/，开发工具，不进入游戏构建产物。设计见 docs/proposal/2026-10-22-bench.md。
 * 主要能力：解析命令行参数；给出构建上下文的白名单；从场景输出中提取原始结果；把样本汇总为中位数与分位数；
 * 与基准文件比较并生成报告。本文件不读写文件、不启动进程，所有输入由调用方提供。
 * 判定规则：工作量计数与基准不同即失败（算法行为改变，须确认后更新基准）；CPU 的 10% 分位数超过基准 (1 + 容差) 倍为回归，
 * 同样失败；快于基准、新增或缺少的用例只报告。判定取 10% 分位数而不取中位数：私服实测中同一用例的样本会在运行中途
 * 整体跳到另一档（V8 优化状态改变），中位数随之波动近一倍，而 10% 分位数在多次运行间的差异在 3% 以内，算法回归同样体现在其中。CPU 来自私服的 Game.cpu.getUsed()，不同机器之间只比较同一台机器上的基准。
 */
import { parseArgs } from 'node:util';

/** 基准测试镜像的标签：与场景测试镜像共用依赖层缓存，bot 层不同，所以使用独立标签避免互相覆盖。 */
export const BENCH_IMAGE = 'leviathan-bench:local';
/** 基准文件（仓库内路径）。 */
export const BASELINE_FILE = 'test/bench/baseline.json';
/** bench 场景输出原始结果的行前缀。 */
export const RESULT_PREFIX = 'BENCH_RESULT ';
/** 场景名，与 test/bench/scenarios/bench.scenario.js 对应。 */
export const BENCH_SCENARIO = 'bench';
/** 默认容差：CPU 的 10% 分位数超过基准 30% 判为回归。私服计时受机器负载影响，容差不宜过小。 */
export const DEFAULT_TOLERANCE = 0.3;

/** 用法说明。 */
export const USAGE = '用法：npm run bench -- [--update] [--tolerance <比例>]（--update 写入基准文件；容差默认 0.3）';

/**
 * 构建上下文的白名单：[仓库内路径, 上下文内路径]。镜像与场景测试相同，只把场景目录换成 bench 场景。
 */
export const BENCH_INPUTS: readonly (readonly [string, string])[] = [
  ['test/scenarios/runner/Dockerfile', 'Dockerfile'],
  ['test/scenarios/runner/package.json', 'package.json'],
  ['test/scenarios/runner/package-lock.json', 'package-lock.json'],
  ['test/scenarios/runner/.npmrc', '.npmrc'],
  ['test/scenarios/scenarios.config.cjs', 'scenarios.config.cjs'],
  ['test/bench/scenarios', 'scenarios'],
  ['test/scenarios/support', 'support'],
];

/** 解析后的命令行参数。 */
export interface BenchArgs {
  /** 把本次结果写入基准文件。 */
  readonly update: boolean;
  /** CPU 回归的容差比例。 */
  readonly tolerance: number;
}

/** 场景输出的单个用例原始记录（与 test/bench/runtime.ts 的 CaseRecord 一致）。 */
export interface RawRecord {
  readonly name: string;
  readonly batch: number;
  readonly cpu: readonly number[];
  readonly heap: readonly (number | null)[];
  readonly work: number;
}

/** 场景输出的原始结果。 */
export interface RawResult {
  readonly env: { readonly node: string; readonly engine: string };
  readonly ticks: number;
  readonly records: readonly RawRecord[];
}

/** 单个用例的汇总。 */
export interface CaseSummary {
  readonly batch: number;
  readonly samples: number;
  /** 每次迭代的 CPU（毫秒）：中位数与 10%、90% 分位数。 */
  readonly cpu: { readonly median: number; readonly p10: number; readonly p90: number };
  /** 每次迭代堆增量（字节）的中位数；平台不提供时为 null。 */
  readonly heap: number | null;
  readonly work: number;
}

/** 汇总结果，也是基准文件的格式。 */
export interface Summary {
  readonly env: RawResult['env'];
  /** { [用例名]: 汇总 } */
  readonly cases: Readonly<Record<string, CaseSummary>>;
}

/** 比较结论。 */
export type RowStatus = 'ok' | 'faster' | 'slower' | 'work-changed' | 'new' | 'missing';

/** 报告中的一行。 */
export interface Row {
  readonly name: string;
  readonly status: RowStatus;
  /** 本次每次迭代 CPU 的 10% 分位数（毫秒），判定所用的统计量。 */
  readonly cpu: number | null;
  /** 基准的 10% 分位数（毫秒）。 */
  readonly base: number | null;
  /** cpu ÷ base；任一方缺失时为 null。 */
  readonly ratio: number | null;
  /** 本次的中位数（毫秒），只用于报告。 */
  readonly median: number | null;
  readonly heap: number | null;
  readonly work: number | null;
  readonly baseWork: number | null;
}

/**
 * @description 解析命令行参数。
 * @param argv 去掉 node 与脚本路径后的命令行参数。
 * @returns 解析结果。
 * @throws {Error} 出现未知选项、位置参数，或容差不是非负数；消息包含用法说明。
 */
export const parseBenchArgs = (argv: readonly string[]): BenchArgs => {
  let values: { update?: boolean; tolerance?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { update: { type: 'boolean' }, tolerance: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${USAGE}`);
  }
  const tolerance = values.tolerance === undefined ? DEFAULT_TOLERANCE : Number(values.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error(`容差不合法：${values.tolerance}\n${USAGE}`);
  return { update: values.update === true, tolerance };
};

/**
 * @description 从场景输出中取出最后一行原始结果。
 * @param stdout 容器的标准输出。
 * @returns 原始结果。
 * @throws {Error} 输出中没有结果行，或结果的结构不符合预期。
 */
export const extractResult = (stdout: string): RawResult => {
  const line = stdout.split('\n').reverse().find((l) => l.startsWith(RESULT_PREFIX));
  if (line === undefined) throw new Error('场景输出中没有基准结果');
  const result = JSON.parse(line.slice(RESULT_PREFIX.length)) as RawResult;
  if (!Array.isArray(result?.records) || typeof result.env?.node !== 'string') throw new Error('基准结果的结构不符合预期');
  for (const r of result.records) {
    if (typeof r.name !== 'string' || !Array.isArray(r.cpu) || r.cpu.length === 0 || !Number.isFinite(r.work)) {
      throw new Error(`用例记录不完整：${JSON.stringify(r).slice(0, 120)}`);
    }
  }
  return result;
};

/**
 * @description 有序数组的分位数，按线性插值。
 * @param sorted 升序数组，至少一个元素。
 * @param q 分位，0–1。
 * @returns 分位数。
 */
const quantile = (sorted: readonly number[], q: number): number => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * @description 把原始样本汇总为中位数与分位数。
 * @param raw 原始结果。
 * @returns 汇总；用例按原始顺序作为对象的键。
 * @throws {Error} 用例名重复。
 */
export const summarize = (raw: RawResult): Summary => {
  const cases: Record<string, CaseSummary> = {};
  for (const r of raw.records) {
    if (r.name in cases) throw new Error(`用例名重复：${r.name}`);
    const cpu = [...r.cpu].sort((a, b) => a - b);
    const heap = r.heap.filter((h): h is number => h !== null).sort((a, b) => a - b);
    cases[r.name] = {
      batch: r.batch,
      samples: cpu.length,
      cpu: { median: quantile(cpu, 0.5), p10: quantile(cpu, 0.1), p90: quantile(cpu, 0.9) },
      heap: heap.length === 0 ? null : quantile(heap, 0.5),
      work: r.work,
    };
  }
  return { env: raw.env, cases };
};

/**
 * @description 与基准比较。
 * @param current 本次汇总。
 * @param baseline 基准；没有基准文件时为 null，此时全部用例为 new。
 * @param tolerance CPU 回归的容差比例。
 * @returns 报告行（本次的用例在前，基准中有而本次没有的用例在后）与是否失败。
 */
export const compare = (current: Summary, baseline: Summary | null, tolerance: number): { rows: Row[]; failed: boolean } => {
  const rows: Row[] = [];
  for (const [name, c] of Object.entries(current.cases)) {
    const b = baseline?.cases[name];
    if (b === undefined) {
      rows.push({ name, status: 'new', cpu: c.cpu.p10, base: null, ratio: null, median: c.cpu.median, heap: c.heap, work: c.work, baseWork: null });
      continue;
    }
    const ratio = c.cpu.p10 / b.cpu.p10;
    let status: RowStatus = 'ok';
    if (c.work !== b.work) status = 'work-changed';
    else if (ratio > 1 + tolerance) status = 'slower';
    else if (ratio < 1 / (1 + tolerance)) status = 'faster';
    rows.push({ name, status, cpu: c.cpu.p10, base: b.cpu.p10, ratio, median: c.cpu.median, heap: c.heap, work: c.work, baseWork: b.work });
  }
  for (const [name, b] of Object.entries(baseline?.cases ?? {})) {
    if (!(name in current.cases)) {
      rows.push({ name, status: 'missing', cpu: null, base: b.cpu.p10, ratio: null, median: null, heap: null, work: null, baseWork: b.work });
    }
  }
  return { rows, failed: rows.some((r) => r.status === 'work-changed' || r.status === 'slower') };
};

/**
 * @description 把数值格式化为报告单元格。
 * @param value 数值；null 显示为 "—"。
 * @param digits 小数位数。
 * @returns 文本。
 */
const cell = (value: number | null, digits: number): string => (value === null ? '—' : value.toFixed(digits));

/**
 * @description 生成文本报告。
 * @param rows 报告行。
 * @param current 本次汇总，用于输出运行环境与样本数。
 * @param baseline 基准；用于输出基准的运行环境。
 * @returns 多行文本。
 */
export const formatReport = (rows: readonly Row[], current: Summary, baseline: Summary | null): string => {
  const lines = [
    `运行环境：Node ${current.env.node}，引擎 ${current.env.engine}` +
      (baseline === null ? '；没有基准文件' : `；基准：Node ${baseline.env.node}，引擎 ${baseline.env.engine}`),
    '用例 | 状态 | CPU P10 (ms) | 基准 P10 (ms) | 比值 | 中位数 (ms) | 堆增量 (B) | 工作量 | 基准工作量',
  ];
  for (const r of rows) {
    lines.push([
      r.name, r.status, cell(r.cpu, 5), cell(r.base, 5), cell(r.ratio, 2), cell(r.median, 5), cell(r.heap, 0),
      r.work === null ? '—' : String(r.work), r.baseWork === null ? '—' : String(r.baseWork),
    ].join(' | '));
  }
  return lines.join('\n');
};
