/**
 * 文件摘要：lib.grid，房间 50×50 网格上的原语：距离变换、多源 BFS、洪水填充与邻居枚举（设计见 docs/design/lib/grid.md，架构设计 12.1、12.2）。
 *
 * 所属位置：src/lib/grid/，lib 层的无状态纯函数，供布局规划、威胁场、扩张评分与 tower 覆盖共用。
 * 网格以 lib.geometry 的房间内打包 `y × 50 + x` 为下标，阻挡图是 Uint8Array(2500)：非 0 表示不可通行。
 * 连通性为 8 邻接，与 creep 的移动一致。
 * 热路径约束（12.1）：只用命令式循环与 TypedArray，不用闭包回调；输出数组与队列缓冲区都由调用方传入，
 * 便于在多次调用间复用，也满足 lib 不得持有模块级可变状态的边界规则——本模块不缓存任何缓冲区。
 * 复杂度：每个函数 O(2500)，每格至多入队一次。
 * 扩展方式：bfs 与 floodFill 对出队格遍历夹在房间内的 3×3 范围（行优先），不逐方向查偏移表再判断越界；
 * 私服 bench 中整房扩展的耗用约为逐方向写法的 1/4（docs/proposal/2026-10-22-bench.md）。入队顺序因此为行优先，
 * 距离与标记结果与方向顺序无关。neighbors 对外承诺方向 1–8 的顺序，仍按偏移表枚举。
 */
import { DIRECTION_DX, DIRECTION_DY, ROOM_SIZE } from '@/lib/geometry';

/** 网格的格数。 */
export const GRID_SIZE = ROOM_SIZE * ROOM_SIZE;
/** bfs 输出中不可达格的值。 */
export const UNREACHED = 0xffff;
/** 房间内坐标的最大值。 */
const LAST = ROOM_SIZE - 1;

/** 可按下标写入整数的缓冲区：TypedArray 或普通数组。 */
export type IndexBuffer = { [index: number]: number };

/**
 * @description 枚举一格在房间内的邻格，按方向 1–8（TOP 起顺时针）的顺序写入 out，超出房间的方向跳过。
 * @param index 房间内打包下标，0–2499。
 * @param out 输出缓冲区，至少 8 个元素；从下标 0 开始写入。
 * @returns 写入的邻格数，0–8。
 */
export const neighbors = (index: number, out: IndexBuffer): number => {
  const x = index % ROOM_SIZE;
  const y = (index - x) / ROOM_SIZE;
  let n = 0;
  for (let d = 1; d <= 8; d += 1) {
    const nx = x + DIRECTION_DX[d];
    const ny = y + DIRECTION_DY[d];
    if (nx >= 0 && nx < ROOM_SIZE && ny >= 0 && ny < ROOM_SIZE) out[n++] = ny * ROOM_SIZE + nx;
  }
  return n;
};

/**
 * @description Chebyshev 距离变换：每个可通行格到最近的阻挡格或房间外的距离；阻挡格为 0，边缘格至多为 1。
 * 两遍扫描：正向取左、左上、上、右上的最小值加 1，反向再取右、右下、下、左下的最小值加 1；
 * 3×3 邻域的单位权重扫描对 Chebyshev 距离是精确的。用于选出离墙最远的开阔区域放置核心（架构 9.6）。
 * @param blocked 阻挡图，长度 2500，非 0 为阻挡。
 * @param out 输出，长度 2500；结果至多 25，不会溢出 Uint8Array。
 * @returns out 本身。
 */
export const distanceTransform = (blocked: Uint8Array, out: Uint8Array): Uint8Array => {
  for (let y = 0; y < ROOM_SIZE; y += 1) {
    for (let x = 0; x < ROOM_SIZE; x += 1) {
      const i = y * ROOM_SIZE + x;
      if (blocked[i] !== 0) {
        out[i] = 0;
        continue;
      }
      // 房间外按距离 0 处理，所以边缘格的结果为 1。
      let m = x === 0 ? 0 : out[i - 1];
      if (y > 0) {
        const up = out[i - ROOM_SIZE];
        if (up < m) m = up;
        const ul = x === 0 ? 0 : out[i - ROOM_SIZE - 1];
        if (ul < m) m = ul;
        const ur = x === LAST ? 0 : out[i - ROOM_SIZE + 1];
        if (ur < m) m = ur;
      } else m = 0;
      out[i] = m + 1;
    }
  }
  for (let y = LAST; y >= 0; y -= 1) {
    for (let x = LAST; x >= 0; x -= 1) {
      const i = y * ROOM_SIZE + x;
      if (out[i] === 0) continue;
      let m = x === LAST ? 0 : out[i + 1];
      if (y < LAST) {
        const down = out[i + ROOM_SIZE];
        if (down < m) m = down;
        const dr = x === LAST ? 0 : out[i + ROOM_SIZE + 1];
        if (dr < m) m = dr;
        const dl = x === 0 ? 0 : out[i + ROOM_SIZE - 1];
        if (dl < m) m = dl;
      } else m = 0;
      if (m + 1 < out[i]) out[i] = m + 1;
    }
  }
  return out;
};

/**
 * @description 多源 BFS：从一组源格出发，按 8 邻接的步数填写到最近源的距离。
 * 源格的距离为 0，即使源格本身是阻挡（例如以 source、controller 为源）；扩展只进入可通行格。
 * @param sources 源格的打包下标；重复的源只处理一次。
 * @param blocked 阻挡图，长度 2500，非 0 为阻挡。
 * @param out 输出，长度 2500；不可达或超过 maxDistance 的格为 UNREACHED。
 * @param queue 队列缓冲区，长度至少 2500。
 * @param maxDistance 最大距离，缺省不限；距离为 maxDistance 的格仍写入，但不再向外扩展。
 * @returns 写入距离的格数（含源格）。
 */
export const bfs = (
  sources: ArrayLike<number>,
  blocked: Uint8Array,
  out: Uint16Array,
  queue: Uint16Array,
  maxDistance: number = UNREACHED - 1,
): number => {
  out.fill(UNREACHED);
  let tail = 0;
  for (let k = 0; k < sources.length; k += 1) {
    const s = sources[k];
    if (out[s] === UNREACHED) {
      out[s] = 0;
      queue[tail++] = s;
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    const next = out[i] + 1;
    if (next > maxDistance) continue;
    const x = i % ROOM_SIZE;
    const y = (i - x) / ROOM_SIZE;
    // 遍历夹在房间内的 3×3 范围：中心格已有距离，被下面的检查跳过（扩展方式见文件摘要）。
    const x0 = x > 0 ? x - 1 : 0;
    const x1 = x < LAST ? x + 1 : LAST;
    const y1 = y < LAST ? y + 1 : LAST;
    for (let ny = y > 0 ? y - 1 : 0; ny <= y1; ny += 1) {
      const row = ny * ROOM_SIZE;
      for (let nx = x0; nx <= x1; nx += 1) {
        const j = row + nx;
        if (blocked[j] !== 0 || out[j] !== UNREACHED) continue;
        out[j] = next;
        queue[tail++] = j;
      }
    }
  }
  return tail;
};

/**
 * @description 洪水填充：把从 start 出发、经 8 邻接可到达的可通行格标记为 mark。
 * out 中非 0 的格视为已访问，不会被覆盖，因此可用不同的 mark 依次标记多个区域；调用方在第一次使用前清零 out。
 * @param start 起点的打包下标。
 * @param blocked 阻挡图，长度 2500，非 0 为阻挡。
 * @param out 标记图，长度 2500。
 * @param queue 队列缓冲区，长度至少 2500。
 * @param mark 标记值，1–255，缺省为 1。
 * @returns 本次标记的格数；起点是阻挡或已标记时为 0。
 */
export const floodFill = (start: number, blocked: Uint8Array, out: Uint8Array, queue: Uint16Array, mark = 1): number => {
  if (blocked[start] !== 0 || out[start] !== 0) return 0;
  out[start] = mark;
  queue[0] = start;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const i = queue[head++];
    const x = i % ROOM_SIZE;
    const y = (i - x) / ROOM_SIZE;
    // 与 bfs 相同的 3×3 范围遍历；中心格已标记，被下面的检查跳过。
    const x0 = x > 0 ? x - 1 : 0;
    const x1 = x < LAST ? x + 1 : LAST;
    const y1 = y < LAST ? y + 1 : LAST;
    for (let ny = y > 0 ? y - 1 : 0; ny <= y1; ny += 1) {
      const row = ny * ROOM_SIZE;
      for (let nx = x0; nx <= x1; nx += 1) {
        const j = row + nx;
        if (blocked[j] !== 0 || out[j] !== 0) continue;
        out[j] = mark;
        queue[tail++] = j;
      }
    }
  }
  return tail;
};
