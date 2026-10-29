# 模块设计：grid（网格原语）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/lib/grid/` |
| 架构章节 | 4.5 grid、12.1 热路径写法、12.2 网格原语 |
| 成熟度 | 定稿 · M2 |

## 1. 职责

单个房间 50×50 网格上的通用原语：Chebyshev 距离变换、多源 BFS、洪水填充与邻居枚举。布局规划（核心选址、道路生长、rampart 最小割的区域划分）、威胁场、扩张评分与 tower 覆盖共用这些原语。只服务于单一使用方的图算法（例如 rampart 最小割）放在使用方内部。

## 2. 表示

- 下标为 [geometry](./geometry.md#2-坐标) 的房间内打包 `y × 50 + x`，0–2499。
- 阻挡图为 `Uint8Array(2500)`，非 0 表示不可通行；由调用方从地形与建筑生成。
- 连通性为 8 邻接，与 creep 的移动一致。

## 3. 原语

| 函数 | 结果 | 说明 |
| --- | --- | --- |
| `distanceTransform(blocked, out)` | 每个可通行格到最近的阻挡格或房间外的 Chebyshev 距离 | 阻挡格为 0，边缘格至多为 1，空房间中心为 25。两遍扫描：正向取左、左上、上、右上，反向取右、右下、下、左下；3×3 单位权重对 Chebyshev 距离是精确的 |
| `bfs(sources, blocked, out, queue, maxDistance?)` | 到最近源格的步数 | 源格距离为 0，即使源格本身是阻挡（例如以 source、controller 为源）；只扩展进可通行格；不可达与超过 `maxDistance` 的格为 `UNREACHED`（`0xffff`）；返回写入距离的格数 |
| `floodFill(start, blocked, out, queue, mark?)` | 从起点可到达的区域标记为 mark | `out` 中非 0 的格视为已访问，可用不同 mark 依次标记多个区域；起点为阻挡或已标记时返回 0 |
| `neighbors(index, out)` | 房间内的邻格 | 按方向 1–8（TOP 起顺时针）写入，跳过房间外，返回个数 |

## 4. 成本与缓冲区

- 每个函数 O(2500)，每格至多入队一次；只用命令式循环与 TypedArray，不用闭包回调（12.1）。
- `bfs` 与 `floodFill` 对出队格遍历夹在房间内的 3×3 范围（行优先），中心格因已访问被跳过；不逐方向查偏移表再判断越界。私服 bench 中，空房间的整房 BFS 约 0.06 CPU，逐方向的写法约为其 4–5 倍。入队顺序因此为行优先，距离与标记结果与扩展顺序无关。`neighbors` 对外承诺方向 1–8 的顺序，仍按偏移表枚举。
- 私服 bench 的参考成本（每次调用，CPU）：`distanceTransform` 约 0.02，`bfs` 与 `floodFill` 约 0.05–0.06，对全部 2500 格调用一次 `neighbors` 约 0.24。基准值与判定方法见 [bench 设计](../../proposal/2026-10-22-bench.md)。
- 输出数组与队列缓冲区（`Uint16Array(2500)`）都由调用方传入并在多次调用间复用。lib 不得持有模块级可变状态（4.2），本模块不缓存缓冲区；每次调用都新建约 5 KB 的数组会给 GC 增加负担。
- `bfs` 先把 `out` 填为 `UNREACHED`；`floodFill` 不清零 `out`，调用方在第一次使用前清零。

## 5. 接口与用法

```ts
GRID_SIZE = 2500
UNREACHED = 0xffff

distanceTransform(blocked: Uint8Array, out: Uint8Array): Uint8Array
bfs(sources: ArrayLike<number>, blocked: Uint8Array, out: Uint16Array, queue: Uint16Array, maxDistance?: number): number
floodFill(start: number, blocked: Uint8Array, out: Uint8Array, queue: Uint16Array, mark?: number): number
neighbors(index: number, out: IndexBuffer): number      // IndexBuffer：TypedArray 或普通数组
```

```ts
const dist = distanceTransform(blocked, scratch8);              // 核心候选：dist ≥ 3 的格可放下 5×5 核心
const reached = bfs([packLocal(s.pos.x, s.pos.y)], blocked, scratch16, queue);
```

## 6. 验证

单元测试在固定种子的随机阻挡图上（5 个种子，密度 0–0.55）对拍：`distanceTransform` 与"以阻挡格为源、不受阻挡限制的逐层扩展再与到房间外的距离取小"一致；`bfs` 与逐层扩展前沿的参考实现一致，含阻挡源、重复源与 `maxDistance`；`floodFill` 与并查集的连通分量一致，可依次标记多个区域。另覆盖邻居枚举的顺序与边界。热路径基准为 `test/bench/cases/grid.ts` 的用例（空房间与密度 0.15、0.4 的距离变换，空房间与密度 0.15 的 BFS，洪水填充，全房邻居枚举），由 `npm run bench` 在私服中计量。
