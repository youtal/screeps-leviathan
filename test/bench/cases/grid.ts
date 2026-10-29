/**
 * 文件摘要：lib.grid 的基准用例（架构 12.2 要求网格原语单独做基准测试）。
 *
 * 所属位置：test/bench/cases/，由 test/bench/cases/index.ts 汇总。输入在 setup 中按固定种子生成，计时只覆盖被测函数；
 * 工作量计数取被测函数的确定性结果（距离之和、写入格数等），算法行为改变时计数随之改变。
 * 密度取 0.15 与 0.4，分别近似开阔房间与多墙房间；空房间是距离变换与 BFS 的最坏扩展情形。
 */
import { GRID_SIZE, bfs, distanceTransform, floodFill, neighbors } from '@/lib/grid';
import { packLocal } from '@/lib/geometry';

import { randomBlocked } from '../random';
import { defineCase } from '../runtime';
import type { BenchCase } from '../runtime';

/**
 * @description 距离变换用例。
 * @param variant 变体名。
 * @param blocked 阻挡图。
 * @returns 用例；工作量计数为全部格的距离之和。
 */
const distanceCase = (variant: string, blocked: Uint8Array): BenchCase =>
  defineCase(`grid.distanceTransform/${variant}`, () => ({ blocked, out: new Uint8Array(GRID_SIZE) }), (s) => {
    distanceTransform(s.blocked, s.out);
    let sum = 0;
    for (let i = 0; i < GRID_SIZE; i += 1) sum += s.out[i];
    return sum;
  });

/**
 * @description 多源 BFS 用例：以房间内三个固定格为源。
 * @param variant 变体名。
 * @param blocked 阻挡图。
 * @returns 用例；工作量计数为写入距离的格数。
 */
const bfsCase = (variant: string, blocked: Uint8Array): BenchCase =>
  defineCase(`grid.bfs/${variant}`, () => ({
    blocked,
    sources: [packLocal(10, 10), packLocal(40, 25), packLocal(25, 40)],
    out: new Uint16Array(GRID_SIZE),
    queue: new Uint16Array(GRID_SIZE),
  }), (s) => bfs(s.sources, s.blocked, s.out, s.queue));

/** 全部 grid 用例。 */
export const GRID_CASES: readonly BenchCase[] = [
  distanceCase('empty', new Uint8Array(GRID_SIZE)),
  distanceCase('d15', randomBlocked(1, 0.15)),
  distanceCase('d40', randomBlocked(2, 0.4)),
  bfsCase('empty', new Uint8Array(GRID_SIZE)),
  bfsCase('d15', randomBlocked(1, 0.15)),
  defineCase('grid.floodFill/d15', () => ({
    blocked: randomBlocked(1, 0.15), out: new Uint8Array(GRID_SIZE), queue: new Uint16Array(GRID_SIZE),
  }), (s) => {
    // 每次迭代先清零标记图：floodFill 把非 0 格视为已访问。清零计入耗用，约占一次 2500 字节的写入。
    s.out.fill(0);
    return floodFill(packLocal(25, 25), s.blocked, s.out, s.queue) + floodFill(packLocal(5, 5), s.blocked, s.out, s.queue, 2);
  }),
  defineCase('grid.neighbors/sweep', () => new Int16Array(8), (out) => {
    let total = 0;
    for (let i = 0; i < GRID_SIZE; i += 1) total += neighbors(i, out);
    return total;
  }),
];
