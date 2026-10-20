# 模块设计：geometry（坐标、方向与距离）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/lib/geometry/` |
| 架构章节 | 4.5 geometry、12.1 热路径写法、12.2 世界坐标打包 |
| 成熟度 | 定稿 · M1 |

## 1. 职责

坐标换算与打包、方向与距离的纯函数，供 lib.grid、movement、布局与情报使用。热路径函数只做整数运算，不分配对象（12.1）。

## 2. 坐标

| 坐标 | 定义 | 范围 |
| --- | --- | --- |
| 房间坐标 | `W{n}` → −n−1、`E{n}` → n；`N{n}` → −n−1、`S{n}` → n | 编号 0–999，即 −1000 到 999 |
| 房间内打包 | `y × 50 + x` | 0–2499，即 lib.grid 中 `Uint8Array(2500)` 的下标 |
| 全局坐标 | `(房间X × 50 + x, 房间Y × 50 + y)` | 每个分量的绝对值不超过 50 000 |
| 世界打包 | `(全局X + 65536) × 131072 + (全局Y + 65536)` | 非负安全整数，小于 2^34 |

- 房间坐标与房间名的换算与引擎 4.3.2 `utils.js` 的 `roomNameToXY`、`getRoomNameFromXY` 一致。房间名只接受大写方向字母、无前导零的 1–3 位编号；`sim` 等非世界房间返回 `undefined`。
- 全局坐标中，`W0` 的 x = 49 与 `E0` 的 x = 0 相差 1。它们在游戏中是同一位置：creep 走上出口格后，同一 tick 被转到相邻房间的对边（engine `src/processor/intents/creeps/tick.js`）。全局坐标只是格的编号，不表示可走的步数。
- 世界打包用算术而不是位运算：两个分量各需 17 位，超过 32 位整数。打包值可直接作为 Map 键与排序键；同一全局 y 上，打包值随全局 x 递增。

## 3. 方向与距离

- **方向编码**与引擎常量一致：`TOP = 1` 起顺时针到 `TOP_LEFT = 8`，y 轴向下为正；0 表示同一格。偏移表 `DIRECTION_DX`、`DIRECTION_DY` 以方向值为下标，与引擎的 `offsetsByDirection` 一致。
- **`direction(dx, dy)`** 与引擎的 `getDirection` 规则相同：一个分量的绝对值超过另一个的 2 倍时取正方向，否则取斜方向。
- **`worldRange(a, b)`** 是全局格坐标的 Chebyshev 距离：同一房间内等于 `getRangeTo`。跨房时不是步数的下界：每跨一条房间边界多计 1（第 2 节），例如从 `W0N0 (48,25)` 到 `E0N0 (1,25)` 只需 2 步，`worldRange` 为 3。用作寻路启发值时，应减去跨越的边界数。

## 4. 接口与用法

```ts
ROOM_SIZE = 50
type Direction = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
DIRECTION_DX, DIRECTION_DY: readonly number[]          // 下标为方向值

roomCoords(name): { x, y } | undefined                  // 房间名 → 房间坐标
roomName(x, y): string                                  // 越界抛 RangeError
packLocal(x, y) / localX(p) / localY(p)                 // 调用方保证 0 ≤ x, y < 50，不检查
packWorld(room, x, y): number | undefined               // 房间名或坐标非法时为 undefined
worldX(p) / worldY(p)                                   // 全局坐标，可为负
unpackWorld(p): { room, x, y }                          // 新建对象，不用于热路径
worldRange(a, b): number
direction(dx, dy): Direction
```

- 热路径（距离、方向、取坐标、房间内打包）不做参数检查，由调用方保证输入来自打包函数。
- `roomCoords`、`packWorld`、`unpackWorld` 解析或生成字符串，适合在缓存建立时调用一次，结果按打包值保存。

## 5. 验证

单元测试中，方向（位移 −6…6 共 169 组）以及房间名与坐标的互换，逐项与 `@screeps/engine` 4.3.2 的采样结果比对。采样在场景测试镜像中运行引擎的 `utils.js` 生成，保存为 `test/lib/fixtures/engine-geometry.json`。另覆盖两种打包的往返、跨房边界的连续性、排序、距离与非法输入。
