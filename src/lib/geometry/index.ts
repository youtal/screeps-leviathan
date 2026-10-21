/**
 * 文件摘要：lib.geometry，坐标打包、房间坐标、方向与距离（设计见 docs/design/lib/geometry.md，架构设计 4.5、12.2）。
 *
 * 所属位置：src/lib/geometry/，lib 层的无状态纯函数，供网格、移动、布局与情报使用。
 * 三种坐标：
 *   - 房间坐标：`W{n}` → −n−1、`E{n}` → n，`N{n}` → −n−1、`S{n}` → n，与引擎 utils.js 的 roomNameToXY 一致；
 *   - 房间内打包：`y × 50 + x`，0–2499，即 lib.grid 的 Uint8Array(2500) 下标；
 *   - 世界打包：全局坐标 (房间X × 50 + x, 房间Y × 50 + y) 编码为一个非负安全整数，跨房距离、排序与缓存键都是整数运算。
 * 热路径约束：房间内打包、取坐标、距离与方向只做整数运算，不分配对象；packWorld、roomCoords 与 unpackWorld 解析或生成
 * 房间名，执行正则并新建对象，适合在缓存建立时调用一次（审计 S-26）。
 * 没有模块级可变状态：方向偏移表是冻结的常量数组。
 */

/** 房间边长（格）。 */
export const ROOM_SIZE = 50;

/** 方向编码与引擎常量一致：TOP=1 起顺时针到 TOP_LEFT=8；0 表示同一格，没有方向。 */
export type Direction = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** 方向 1–8 的 x 偏移（下标为方向值，下标 0 为同一格）；y 轴向下为正，与游戏坐标一致。 */
export const DIRECTION_DX: readonly number[] = Object.freeze([0, 0, 1, 1, 1, 0, -1, -1, -1]);
/** 方向 1–8 的 y 偏移（下标为方向值）。 */
export const DIRECTION_DY: readonly number[] = Object.freeze([0, -1, -1, 0, 1, 1, 1, 0, -1]);

/** 房间名：方向字母大写，编号 0–999 且无前导零（引擎按 1–3 位数字解析）。 */
const ROOM_NAME = /^([WE])(0|[1-9]\d{0,2})([NS])(0|[1-9]\d{0,2})$/;
/** 世界坐标的偏移：房间编号不超过 999 时 |全局坐标| ≤ 50000，加偏移后为非负。 */
const WORLD_OFFSET = 65536;
/** 世界打包中 y 所占的跨度；打包值 < 2^34，远小于 2^53，用算术而非位运算编码。 */
const WORLD_SPAN = 131072;

/** 房间坐标。 */
export interface RoomCoords {
  readonly x: number;
  readonly y: number;
}

/** 房间内的位置。 */
export interface RoomPos {
  readonly room: string;
  readonly x: number;
  readonly y: number;
}

/**
 * @description 把房间名换算为房间坐标。
 * @param name 房间名，例如 `W1N1`；`sim` 等非世界房间与小写写法不接受。
 * @returns 房间坐标；名称非法时为 undefined。
 */
export const roomCoords = (name: string): RoomCoords | undefined => {
  const m = ROOM_NAME.exec(name);
  if (m === null) return undefined;
  const h = Number(m[2]);
  const v = Number(m[4]);
  return { x: m[1] === 'W' ? -h - 1 : h, y: m[3] === 'N' ? -v - 1 : v };
};

/**
 * @description 由房间坐标生成房间名，与引擎 utils.js 的 getRoomNameFromXY 一致。
 * @param x 房间 X 坐标，−1000 到 999 的整数。
 * @param y 房间 Y 坐标，−1000 到 999 的整数。
 * @returns 房间名。
 * @throws {RangeError} 坐标不是该范围内的整数。
 */
export const roomName = (x: number, y: number): string => {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < -1000 || x > 999 || y < -1000 || y > 999) {
    throw new RangeError('房间坐标超出范围');
  }
  return `${x < 0 ? `W${-x - 1}` : `E${x}`}${y < 0 ? `N${-y - 1}` : `S${y}`}`;
};

/**
 * @description 房间内坐标打包为 `y × 50 + x`。调用方保证 0 ≤ x, y < 50，热路径不做检查。
 * @param x 房间内 x 坐标。
 * @param y 房间内 y 坐标。
 * @returns 0–2499 的下标。
 */
export const packLocal = (x: number, y: number): number => y * ROOM_SIZE + x;

/**
 * @description 取房间内打包值的 x 坐标。
 * @param packed packLocal 的结果。
 * @returns x 坐标。
 */
export const localX = (packed: number): number => packed % ROOM_SIZE;

/**
 * @description 取房间内打包值的 y 坐标。
 * @param packed packLocal 的结果。
 * @returns y 坐标。
 */
export const localY = (packed: number): number => (packed - (packed % ROOM_SIZE)) / ROOM_SIZE;

/**
 * @description 把房间内的位置打包为世界坐标整数。成本：经 roomCoords 解析房间名，每次执行一次正则并新建一个坐标对象，
 * 不适合在热路径逐格调用；应在建立缓存时调用一次，之后以打包值做整数运算（geometry 设计第 4 节）。
 * @param room 房间名。
 * @param x 房间内 x 坐标，0–49。
 * @param y 房间内 y 坐标，0–49。
 * @returns 非负安全整数；房间名或坐标非法时为 undefined。
 */
export const packWorld = (room: string, x: number, y: number): number | undefined => {
  const c = roomCoords(room);
  if (c === undefined || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= ROOM_SIZE || y < 0 || y >= ROOM_SIZE) {
    return undefined;
  }
  return (c.x * ROOM_SIZE + x + WORLD_OFFSET) * WORLD_SPAN + (c.y * ROOM_SIZE + y + WORLD_OFFSET);
};

/**
 * @description 取世界打包值的全局 x 坐标（房间X × 50 + x）。
 * @param packed packWorld 的结果。
 * @returns 全局 x 坐标，可为负。
 */
export const worldX = (packed: number): number => Math.floor(packed / WORLD_SPAN) - WORLD_OFFSET;

/**
 * @description 取世界打包值的全局 y 坐标（房间Y × 50 + y）。
 * @param packed packWorld 的结果。
 * @returns 全局 y 坐标，可为负。
 */
export const worldY = (packed: number): number => (packed % WORLD_SPAN) - WORLD_OFFSET;

/**
 * @description 把世界打包值还原为房间名与房间内坐标。
 * @param packed packWorld 的结果。
 * @returns 新建的位置对象。
 */
export const unpackWorld = (packed: number): RoomPos => {
  const gx = worldX(packed);
  const gy = worldY(packed);
  // Math.floor 对负坐标向下取整：全局 x = −1 属于房间 X = −1（W0）的 x = 49。
  const rx = Math.floor(gx / ROOM_SIZE);
  const ry = Math.floor(gy / ROOM_SIZE);
  return { room: roomName(rx, ry), x: gx - rx * ROOM_SIZE, y: gy - ry * ROOM_SIZE };
};

/**
 * @description 两个世界坐标之间全局格坐标的 Chebyshev 距离。同一房间内等于引擎的 getRangeTo。
 * 跨房时不是步数的下界：creep 走上出口格后，同一 tick 被转到相邻房间的对边（engine processor/intents/creeps/tick.js），
 * 出口格两侧实际是同一位置，所以每跨一条房间边界多计 1。用作寻路启发值时，应减去跨越的边界数。
 * @param a packWorld 的结果。
 * @param b packWorld 的结果。
 * @returns 非负整数距离。
 */
export const worldRange = (a: number, b: number): number =>
  Math.max(Math.abs(worldX(a) - worldX(b)), Math.abs(worldY(a) - worldY(b)));

/**
 * @description 按位移计算方向，规则与引擎 utils.js 的 getDirection 一致：一个分量超过另一个的 2 倍时取正方向，否则取斜方向。
 * @param dx 目标减起点的 x 位移。
 * @param dy 目标减起点的 y 位移（向下为正）。
 * @returns 方向 1–8；位移为 0 时为 0。
 */
export const direction = (dx: number, dy: number): Direction => {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx > ady * 2) return dx > 0 ? 3 : 7;
  if (ady > adx * 2) return dy > 0 ? 5 : 1;
  if (dx > 0) return dy > 0 ? 4 : 2;
  if (dx < 0) return dy > 0 ? 6 : 8;
  return 0;
};
