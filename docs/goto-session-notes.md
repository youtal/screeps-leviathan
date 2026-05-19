# goto 模块本轮设计讨论记录

记录日期：2026-05-19

本文记录本轮关于 `goto` 模块技术设计的讨论、结论和后续开发顺序。系统重启续接方式相关讨论未纳入本文。

## 1. 当前状态

- 设计文档位置：`src/modules/goto/README.md`
- 当前仓库尚未实现 `goto` TypeScript 代码，只有设计文档。
- 本轮已对 `src/modules/goto/README.md` 做设计修订，重点收敛跨房路由场缓存、Flow Field 失效机制、CostMatrix 版本维度、Dijkstra 成本语义和首版避让范围。

## 2. 初始技术评审结论

`goto` 的总体方向成立：跨房 A* + 房内 Flow Field 适合 Screeps 中多个 creep 共享局部移动目标的场景。heap-only 缓存、Memory 只保存用户偏好也较合理。

初始评审提出的主要风险：

- Flow Field 与 CostMatrix 的事件戳绑定和失效规则不够闭合。
- 主流程中的 Flow Field TTL 检查顺序容易造成旧缓存命中后再判废。
- 跨房路线缓存 key 信息不足。
- 文档多处提到 `matrixProfile`，但 `GotoOptions` 没有定义该字段。
- Flow Field Dijkstra 的成本语义需要明确。
- 出口 Flow Field 可能导致 creep 在房间边界来回横跳。
- 避让请求与立即 `creep.move` 的执行模型存在冲突。
- Flow Field 局部复用算法首版复杂度较高。

## 3. 用户澄清后的正式设计理解

### 3.1 Flow Field 与 CostMatrix 失效

Flow Field 不采用单纯 TTL 失效，而采用两类失效：

1. 重大 CostMatrix 更新主动失效。
2. 周期性保留性评分失效。

模块基于事件总线监听房间内建筑变化，并由 `goto` 模块内部判断是否属于重大更新。调用方通常不负责判断 `critical=true`。

重大更新包括：

- 不可通行建筑建造完成、消失或被摧毁。
- 非己方或不可通行 rampart 状态变化。
- 房间控制权变化。
- hostile structure、invader core、source keeper lair 等危险结构信息变化。
- 一批道路建设完成时，本批次最后一条道路建成。

道路建设不要求每条道路完成都立即清理 Flow Field。模块可以按房间记录道路建设批次，仅在本批次最后一条道路完成后触发一次重大更新。

非重大更新只更新 CostMatrix eventStamp 并清理旧 CostMatrix，既有 Flow Field 可以继续使用，后续由周期性保留性评估决定是否清理。

### 3.2 Flow Field 保留性评分

未来周期任务管理模块会周期性调用维护任务。该任务扫描 Flow Field 缓存，根据以下因素计算保留性指标：

- Flow Field 质量分数。
- 生成时间。
- 最近活跃时间。
- 复用深度。
- patch 大小。

当保留性指标低于阈值时，清理该 Flow Field。

初始评分模型：

```text
retentionScore =
  flowField.score
  + activeBonus(activeAt)
  - agePenalty(createdAt)
  - inactivePenalty(activeAt)
  - reusedDepthPenalty
  - patchSizePenalty
```

### 3.3 跨房寻路与路由场缓存

跨房层仍然使用 A*，但不把完整房间序列作为最终缓存形态。A* 只负责计算从当前房间到目标房间的房间序列，然后将结果拆成房间级出口指令缓存。

缓存 key 的核心是：

```text
targetRoom + avoidHostileRooms + roomName
```

缓存值表示：为了抵达 `targetRoom`，creep 位于 `roomName` 时应该走向哪个出口方向。

示例：

```text
W22N11:5
```

含义：当目标房间为当前路由场的 `targetRoom` 时，creep 位于 `W22N11` 应向 `5` 对应的出口方向移动。缓存项还应记录 `nextRoom`，用于边界失败统计和有向边偏好调整。

该缓存本质上是房间级 Flow Field：以目标房间为汇点，每个中间房间只关心下一步应该走哪个出口。

### 3.4 跨房移动查找流程

`goto` 主流程中：

1. 标准化 target 与 options。
2. 判断 creep 是否已在 range 内。
3. 读取 creep 的移动状态和 stuck 计数。
4. 根据目标房间判断是否需要跨房路由。
5. 如果目标在当前房间，当前 RouteSegment 为最终目标。
6. 如果目标不在当前房间，查询或生成跨房路由场，并读取当前房间的出口方向。
7. 将出口方向转换为当前房间的出口 RouteSegment。
8. 按 `considerRoads + considerSwamps` 获取 CostMatrix。
9. CostMatrix 不存在或版本已更新时重建 CostMatrix。
10. 获取匹配且保留性有效的 Flow Field。
11. 如果无匹配 Flow Field，按配置尝试复用或完整建场。
12. 从 Flow Field 读取当前位置方向。
13. 检查目标格动态阻塞。
14. 无阻塞时执行 `creep.move(direction)`。
15. 有阻塞时尝试轻量绕行。
16. 绕行失败时创建 AvoidanceRequest 或返回 blocked。
17. 记录 PendingMove。
18. 返回 GotoResult。

### 3.5 CostMatrix 版本维度

当前版本不引入额外 `matrixProfile` 维度。具体使用哪套 CostMatrix 由 `GotoOptions` 中的两个字段共同决定：

- `considerRoads`
- `considerSwamps`

同一个房间存在 4 套基础 CostMatrix：

```text
roads=true,  swamps=true
roads=true,  swamps=false
roads=false, swamps=true
roads=false, swamps=false
```

后续如果需要 combat、dismantler 等特殊成本模型，再扩展独立 profile 维度。

### 3.6 Flow Field Dijkstra 成本语义

Flow Field 的 Dijkstra 成本语义明确为：

- 从 `pos` 走向 `next` 的移动代价为 `costMatrix.get(next.x, next.y)`。
- 8 个方向的方向成本相同，不对斜向移动额外加权。
- 允许对角移动，只要目标格在 CostMatrix 中可通行。
- 多目标 range 内的终点格以 CostMatrix 呈现的信息为准，`255` 或不可接受成本的格子不会作为终点。

### 3.7 出口 Flow Field 与边界抖动

采用“跨房路由场 -> 当前房间出口 Flow Field”的方案后，边界抖动风险明显降低，因为出口选择由路由场统一决定，不依赖零散 route segment 推导。

但风险没有完全消失。疲劳、阻塞、路由场刚更新或边界移动失败统计滞后时，仍可能出现边界来回横跳。后续需要通过 PendingMove、跨房 expected 位置和有向边界失败统计兜底。

### 3.8 避让模型

首版保留立即 `creep.move(direction)` 的调用模型，不引入两阶段 intent 调度。

当两个正在赶路的 creep 同 tick 争抢同一个地块时，后调用或被挡住的 creep 可能停留 1 tick。该代价在首版中视为可接受。

避让请求用于轻量协作：

- 被阻塞 creep 可以发出 AvoidanceRequest。
- 挡路 creep 在后续 tick 或后续行为调用中结合 resolver 决定是否让路。
- 首版不保证同 tick 内完成全局最优避让。
- 首版不处理所有互相让路循环。

### 3.9 Flow Field 复用

用户希望一次开发后尽量实现完整设计意图，因此文档保留 Flow Field 复用设计。

风险判断：

- 边界收敛式局部复用是整个模块中最复杂、最难验证的部分。
- 它必须保证边界后继路径接入可信区域，否则 creep 可能被带回旧目标。
- 复用结果不保证全局最优，因此必须受质量分数、复用深度、目标距离和 patch 大小约束。
- 复用 Flow Field 更容易在周期性保留性评估中被清理。

## 4. 已修改的设计文档内容

本轮已在 `src/modules/goto/README.md` 中完成以下修改：

- 将跨房描述从“路线缓存”调整为“跨房路由场缓存”。
- 将文件规划中的 `findRoomRoute.ts` / `roomRouteCache.ts` 改为 `findRoomExitRoute.ts` / `roomExitRouteCache.ts`。
- 将 CostMatrix 辅助文件从 `profiles.ts` 改为 `terrainCosts.ts`。
- 删除 Flow Field TTL 语义，改为质量分数、生成时间、活跃时间和保留性评分清理。
- 删除 `FlowField.expiresAt`，增加 `FlowField.retentionScore`。
- 明确 `FlowFieldRetentionConfig`。
- 明确重大 CostMatrix 更新由模块内部判断 `critical=true`。
- 明确道路批次完成后再触发一次重大更新。
- 明确当前版本不引入 `matrixProfile`。
- 明确 Flow Field Dijkstra 成本语义。
- 将跨房移动主流程改为先查/建路由场，再查/建出口 Flow Field。
- 将避让描述改为首版轻量协作，不做两阶段 intent 调度。
- 将 debug、缓存上限、开发计划、验收标准和术语中的旧 TTL / Room Route 语义同步更新。

## 5. 推荐开发顺序

建议按“先闭环、再增强”的顺序开发。不要按目录从上到下写，而是每一阶段都产出一个可测试、可运行的移动能力。

### 5.1 基础类型与模块骨架

- `types.ts`
- `createGoto.ts`
- `src/app/modules.ts` 装配
- `GotoOptions`
- `GotoResult`
- `GotoTarget`
- heap cache 容器
- `Memory.goto` 初始化

### 5.2 房间名解析与房间图 A*

- `parseRoomName`
- 相邻房间推导
- 有向边成本
- `RoomPreference`
- `BoundaryPreference`
- 单元测试重点覆盖 `W0/E0/N0/S0` 边界。

### 5.3 跨房路由场缓存

- 实现 `targetRoom + avoidHostileRooms + roomName -> exitDirection`。
- A* 结果拆成每个房间的出口指令。
- 缓存 `nextRoom`、`preferenceVersion`、`routeCost`。
- 先不接 creep 移动，只测试输入当前房间和目标房间能拿到正确出口。

### 5.4 CostMatrix 四版本

- `considerRoads=true/false`
- `considerSwamps=true/false`
- terrain
- road
- blocking structure
- container
- rampart
- constructionSite
- `eventStamp`
- `updateCostMatrix`
- 先把重大更新清理 Flow Field 的接口留好。

### 5.5 完整 Flow Field

- 先只做 full build，不做复用。
- 目标 position + range。
- 出口方向目标。
- Dijkstra 反向扩散。
- `Uint8Array(2500)` 存方向。
- 测试同房目标、不可达、出口目标、range 目标。

### 5.6 `goto()` 最小闭环

- 同房：target -> Flow Field -> `creep.move`。
- 跨房：路由场 -> 出口 Flow Field -> `creep.move`。
- 返回 `arrived`、`blocked`、`pathType`。
- 这一步完成后，模块具备基本可用价值。

### 5.7 PendingMove 与 stuck

- 记录上 tick 预期位置。
- 下 tick 检查是否移动成功。
- `ERR_TIRED` 不应算移动失败。
- 连续 stuck 后强制 full Flow Field 或 fallback。

### 5.8 PathFinder fallback

- Flow Field 构建失败、预算不足、不可达异常时兜底。
- fallback cache 仅 heap。
- 避免同 tick 反复搜索同一个失败目标。

### 5.9 缓存清理与保留性评分

- Flow Field `score`。
- `retentionScore`。
- `activeAt`。
- 周期任务接口先做成 `maintain()` 或 `onTickEnd()` 内部调用，等未来周期任务模块实装后再注册过去。

### 5.10 动态阻塞与轻量避让

- 目标格有 creep 时尝试本地绕行。
- 绕行失败返回 `blocked` 或创建 `AvoidanceRequest`。
- 首版不做两阶段 intent 调度。

### 5.11 Flow Field 复用

- 最后做。
- 先实现复用候选索引。
- 再实现边界收敛 patch。
- 需要 visual/debug 辅助，否则排错成本高。

### 5.12 Debug 与 visual

- 推荐方向。
- 当前 segment。
- 跨房出口方向。
- Flow Field 采样。
- stuck 状态。
- CostMatrix 热区。

## 6. 首条主线

第 1 到第 6 步是第一条主线：

1. 类型与模块骨架。
2. 房间名解析与 A*。
3. 跨房路由场缓存。
4. CostMatrix 四版本。
5. 完整 Flow Field。
6. `goto()` 最小闭环。

完成这条主线后，应得到一个真正能运行的 `goto` 基础版本。

第 7 到第 10 步增强稳定性。第 11 步 Flow Field 复用风险最高，建议在 full Flow Field、跨房路由场和 debug 能力稳定后再接入。
