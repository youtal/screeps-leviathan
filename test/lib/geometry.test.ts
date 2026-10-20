/**
 * 文件摘要：lib.geometry 的单元测试。
 * 覆盖：房间名与房间坐标的互换、方向与偏移表，均与引擎 4.3.2 utils.js 的采样结果逐项比对
 * （fixtures/engine-geometry.json：在场景测试镜像中以 @screeps/engine 4.3.2 的 getDirection、roomNameToXY、
 * getRoomNameFromXY 生成）；房间内与世界坐标打包的往返、跨房边界、距离与非法输入。
 */
import {
  DIRECTION_DX, DIRECTION_DY, ROOM_SIZE, direction, localX, localY, packLocal, packWorld, roomCoords, roomName,
  unpackWorld, worldRange, worldX, worldY,
} from '@/lib/geometry';
import engine from './fixtures/engine-geometry.json';

test('方向与引擎 getDirection 一致（位移 −6…6 共 169 组）', () => {
  for (const [dx, dy, expected] of engine.dir) expect([dx, dy, direction(dx, dy)]).toEqual([dx, dy, expected]);
});

test('偏移表与方向互逆，并与引擎的 offsetsByDirection 一致', () => {
  const offsets = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  for (let d = 1; d <= 8; d += 1) {
    expect([DIRECTION_DX[d], DIRECTION_DY[d]]).toEqual(offsets[d - 1]);
    expect(direction(DIRECTION_DX[d], DIRECTION_DY[d])).toBe(d);
  }
  expect(Object.isFrozen(DIRECTION_DX) && Object.isFrozen(DIRECTION_DY)).toBe(true);
});

test('房间名与房间坐标的互换与引擎一致', () => {
  for (const [name, [x, y]] of engine.rooms as [string, [number, number]][]) expect(roomCoords(name)).toEqual({ x, y });
  for (const [x, y, name] of engine.back as [number, number, string][]) {
    expect(roomName(x, y)).toBe(name);
    expect(roomCoords(name)).toEqual({ x, y });
  }
});

test('非法房间名为 undefined，越界坐标抛 RangeError', () => {
  for (const name of ['sim', 'w1n1', 'W01N1', 'W1000N1', 'W1', 'W1N1 ', 'X1N1', '']) expect(roomCoords(name)).toBeUndefined();
  expect(() => roomName(1000, 0)).toThrow(RangeError);
  expect(() => roomName(0, -1001)).toThrow(RangeError);
  expect(() => roomName(0.5, 0)).toThrow(RangeError);
});

test('房间内打包是 y × 50 + x，可逆', () => {
  expect(packLocal(0, 0)).toBe(0);
  expect(packLocal(49, 49)).toBe(2499);
  for (let p = 0; p < ROOM_SIZE * ROOM_SIZE; p += 1) expect(packLocal(localX(p), localY(p))).toBe(p);
});

test('世界打包往返；全局坐标跨房连续', () => {
  for (const [room, x, y] of [['W0N0', 0, 0], ['E0S0', 49, 49], ['W999N999', 0, 0], ['E999S999', 49, 49], ['W12N34', 25, 7]] as const) {
    const p = packWorld(room, x, y)!;
    expect(Number.isSafeInteger(p) && p >= 0).toBe(true);
    expect(unpackWorld(p)).toEqual({ room, x, y });
  }
  // W0N0 的 x=49 与 E0N0 的 x=0 在全局坐标中相差 1（游戏中两者是同一位置，见 worldRange 的说明）。
  expect(worldX(packWorld('E0N0', 0, 10)!) - worldX(packWorld('W0N0', 49, 10)!)).toBe(1);
  expect(worldY(packWorld('W0S0', 5, 0)!) - worldY(packWorld('W0N0', 5, 49)!)).toBe(1);
  expect(worldX(packWorld('W0N0', 49, 0)!)).toBe(-1);
});

test('世界打包保持字典序：同一行内 x 递增则打包值递增', () => {
  const row = ['W1N1', 'W0N1', 'E0N1', 'E1N1'].flatMap((room) => [0, 49].map((x) => packWorld(room, x, 3)!));
  expect([...row].sort((a, b) => a - b)).toEqual(row);
});

test('距离：同房为 Chebyshev，跨房按全局坐标', () => {
  expect(worldRange(packWorld('W1N1', 10, 10)!, packWorld('W1N1', 13, 8)!)).toBe(3);
  expect(worldRange(packWorld('W0N0', 49, 25)!, packWorld('E0N0', 0, 25)!)).toBe(1);
  expect(worldRange(packWorld('W1N1', 0, 0)!, packWorld('E1S1', 49, 49)!)).toBe(199);
});

test('非法输入：packWorld 为 undefined', () => {
  expect(packWorld('sim', 1, 1)).toBeUndefined();
  expect(packWorld('W1N1', 50, 1)).toBeUndefined();
  expect(packWorld('W1N1', -1, 1)).toBeUndefined();
  expect(packWorld('W1N1', 1.5, 1)).toBeUndefined();
});
