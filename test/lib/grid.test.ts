/**
 * 文件摘要：lib.grid 的单元测试。
 * 覆盖：在固定种子的随机阻挡图上，distanceTransform 与从阻挡格出发的无障碍逐层扩展对拍，bfs 与逐层扩展前沿的参考实现对拍，
 * floodFill 与并查集的参考实现对拍；邻居枚举的顺序与边界；源格为阻挡、重复源、maxDistance、多区域标记。
 */
import { GRID_SIZE, UNREACHED, bfs, distanceTransform, floodFill, neighbors } from '@/lib/grid';
import { packLocal } from '@/lib/geometry';

/**
 * @description mulberry32 伪随机数，测试可复现。
 * @param seed 种子。
 * @returns 返回 [0, 1) 浮点数的函数。
 */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * @description 生成随机阻挡图。
 * @param seed 种子。
 * @param density 阻挡格的比例。
 * @returns 长度 2500 的阻挡图。
 */
const randomBlocked = (seed: number, density: number): Uint8Array => {
  const r = random(seed);
  const blocked = new Uint8Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i += 1) blocked[i] = r() < density ? 1 : 0;
  return blocked;
};

/**
 * @description 参考实现：8 邻接的邻格列表，不依赖被测模块。
 * @param i 打包下标。
 * @returns 邻格下标数组。
 */
const aroundOf = (i: number): number[] => {
  const x = i % 50;
  const y = Math.floor(i / 50);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if ((dx !== 0 || dy !== 0) && x + dx >= 0 && x + dx < 50 && y + dy >= 0 && y + dy < 50) out.push(i + dy * 50 + dx);
    }
  }
  return out;
};
/** 预先算好的邻格表，下标为打包坐标，避免参考实现在松弛循环中反复分配。 */
const AROUND = Array.from({ length: GRID_SIZE }, (_, i) => aroundOf(i));
/**
 * @description 查参考邻格表。
 * @param i 打包下标。
 * @returns 邻格下标数组。
 */
const around = (i: number): readonly number[] => AROUND[i];

const seeds = [1, 2, 3, 4, 5];
const densities = [0, 0.1, 0.3, 0.55];

test('distanceTransform 与逐层扩展的参考距离一致', () => {
  for (const seed of seeds) {
    for (const density of densities) {
      const blocked = randomBlocked(seed, density);
      const out = distanceTransform(blocked, new Uint8Array(GRID_SIZE));
      // 参考：以阻挡格为源、不受阻挡限制的逐层扩展（无障碍时 8 邻接步数即 Chebyshev 距离），
      // 再与到房间外的距离 min(x + 1, y + 1, 50 − x, 50 − y) 取小。
      const ref = new Array<number>(GRID_SIZE).fill(Infinity);
      let frontier: number[] = [];
      for (let i = 0; i < GRID_SIZE; i += 1) if (blocked[i]) { ref[i] = 0; frontier.push(i); }
      for (let d = 1; frontier.length > 0; d += 1) {
        const next: number[] = [];
        for (const i of frontier) for (const j of around(i)) if (ref[j] === Infinity) { ref[j] = d; next.push(j); }
        frontier = next;
      }
      for (let i = 0; i < GRID_SIZE; i += 1) {
        const x = i % 50;
        const y = Math.floor(i / 50);
        const expected = Math.min(ref[i], x + 1, y + 1, 50 - x, 50 - y);
        if (out[i] !== expected) throw new Error(`seed ${seed} density ${density} (${x},${y}): ${out[i]} ≠ ${expected}`);
      }
    }
  }
});

test('distanceTransform：空房间中心为 25，边缘为 1', () => {
  const out = distanceTransform(new Uint8Array(GRID_SIZE), new Uint8Array(GRID_SIZE));
  expect([out[packLocal(0, 0)], out[packLocal(49, 25)], out[packLocal(24, 24)], out[packLocal(25, 25)]]).toEqual([1, 1, 25, 25]);
});

test('bfs 与逐层扩展的参考实现一致，并遵守 maxDistance', () => {
  const queue = new Uint16Array(GRID_SIZE);
  const out = new Uint16Array(GRID_SIZE);
  for (const seed of seeds) {
    for (const density of densities) {
      const blocked = randomBlocked(seed, density);
      const r = random(seed + 100);
      // 源格可以是阻挡格，并含一个重复源。
      const sources = [Math.floor(r() * GRID_SIZE), Math.floor(r() * GRID_SIZE), Math.floor(r() * GRID_SIZE)];
      sources.push(sources[0]);
      for (const max of [UNREACHED - 1, 7]) {
        const count = bfs(sources, blocked, out, queue, max);
        // 参考：逐层扩展前沿集合；阻挡格只作为源（距离 0）参与，不被到达。
        const ref = new Array<number>(GRID_SIZE).fill(Infinity);
        let frontier = [...new Set(sources)];
        for (const x of frontier) ref[x] = 0;
        for (let d = 1; frontier.length > 0 && d <= max; d += 1) {
          const next: number[] = [];
          for (const i of frontier) {
            for (const j of around(i)) {
              if (!blocked[j] && ref[j] === Infinity) {
                ref[j] = d;
                next.push(j);
              }
            }
          }
          frontier = next;
        }
        let reached = 0;
        for (let i = 0; i < GRID_SIZE; i += 1) {
          const expected = ref[i] === Infinity ? UNREACHED : ref[i];
          if (out[i] !== expected) throw new Error(`seed ${seed} density ${density} max ${max} at ${i}: ${out[i]} ≠ ${expected}`);
          if (expected !== UNREACHED) reached += 1;
        }
        expect(count).toBe(reached);
      }
    }
  }
});

test('floodFill 与并查集参考实现一致，可依次标记多个区域', () => {
  const queue = new Uint16Array(GRID_SIZE);
  for (const seed of seeds) {
    const blocked = randomBlocked(seed, 0.45);
    const out = new Uint8Array(GRID_SIZE);
    let mark = 0;
    for (let i = 0; i < GRID_SIZE && mark < 255; i += 1) {
      if (blocked[i] || out[i]) continue;
      mark += 1;
      expect(floodFill(i, blocked, out, queue, mark)).toBeGreaterThan(0);
    }
    // 参考：并查集合并相邻的可通行格，标签为分量的根。
    const parent = Array.from({ length: GRID_SIZE }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let i = 0; i < GRID_SIZE; i += 1) {
      if (blocked[i]) continue;
      for (const j of around(i)) if (!blocked[j]) parent[find(i)] = find(j);
    }
    const label = Array.from({ length: GRID_SIZE }, (_, i) => (blocked[i] ? -1 : find(i)));
    // 同一分量的格标记相同，不同分量标记不同（标记总数未超过 255 时）。
    const byLabel = new Map<number, number>(); // { [参考分量标签]: floodFill 的标记 }
    for (let i = 0; i < GRID_SIZE; i += 1) {
      if (label[i] < 0) {
        expect(out[i]).toBe(0);
        continue;
      }
      const seen = byLabel.get(label[i]);
      if (seen === undefined) byLabel.set(label[i], out[i]);
      else expect(out[i]).toBe(seen);
    }
    if (mark < 255) expect(new Set(byLabel.values()).size).toBe(byLabel.size);
  }
});

test('floodFill：起点为阻挡或已标记时返回 0', () => {
  const blocked = new Uint8Array(GRID_SIZE);
  blocked[0] = 1;
  const out = new Uint8Array(GRID_SIZE);
  const queue = new Uint16Array(GRID_SIZE);
  expect(floodFill(0, blocked, out, queue)).toBe(0);
  expect(floodFill(1, blocked, out, queue)).toBe(GRID_SIZE - 1);
  expect(floodFill(2, blocked, out, queue, 2)).toBe(0);
});

test('neighbors 按方向 1–8 输出，并跳过房间外', () => {
  const out = new Int16Array(8);
  expect(neighbors(packLocal(10, 10), out)).toBe(8);
  expect([...out]).toEqual([
    packLocal(10, 9), packLocal(11, 9), packLocal(11, 10), packLocal(11, 11),
    packLocal(10, 11), packLocal(9, 11), packLocal(9, 10), packLocal(9, 9),
  ]);
  const plain: number[] = [];
  expect(neighbors(packLocal(0, 0), plain)).toBe(3);
  expect(plain).toEqual([packLocal(1, 0), packLocal(1, 1), packLocal(0, 1)]);
  expect(neighbors(packLocal(49, 49), plain)).toBe(3);
  expect(plain.slice(0, 3)).toEqual([packLocal(49, 48), packLocal(48, 49), packLocal(48, 48)]);
});
