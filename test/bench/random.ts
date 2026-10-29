/**
 * 文件摘要：bench 用例共用的确定性输入：固定种子的伪随机数与随机阻挡图。
 *
 * 所属位置：test/bench/，只打进 bench 专用产物。输入必须逐次相同，工作量计数才能与基准文件逐项比较。
 */
import { GRID_SIZE } from '@/lib/grid';

/**
 * @description mulberry32 伪随机数生成器。
 * @param seed 种子。
 * @returns 每次调用返回 [0, 1) 浮点数的函数；同一种子的序列相同。
 */
export const random = (seed: number): (() => number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * @description 生成随机阻挡图。
 * @param seed 种子。
 * @param density 阻挡格比例，0–1。
 * @returns 长度 2500 的阻挡图，非 0 为阻挡。
 */
export const randomBlocked = (seed: number, density: number): Uint8Array => {
  const next = random(seed);
  const blocked = new Uint8Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i += 1) blocked[i] = next() < density ? 1 : 0;
  return blocked;
};
