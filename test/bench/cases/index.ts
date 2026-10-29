/**
 * 文件摘要：bench 的用例清单，按模块汇总；新增热路径模块的基准时在此加入（M2 计划：costMatrix、交通结算、planner）。
 *
 * 所属位置：test/bench/cases/，由 test/bench/main.ts 使用。用例名在清单中必须唯一，作为基准文件中的键。
 */
import { GRID_CASES } from './grid';
import type { BenchCase } from '../runtime';

/** 全部用例，按运行顺序排列。 */
export const CASES: readonly BenchCase[] = [...GRID_CASES];
