# goto 模块技术设计

## 1. 模块定位

`goto` 是 Screeps creep 移动系统的基础模块。它负责跨房间路由选择、房间内移动决策、路径缓存、动态阻塞处理和 creep 避让协调。

`goto` 不包装 `Creep.moveTo`，而是使用“跨房 A* + 房内 Flow Field”的两层寻路结构：

1. **跨房间层**：在房间图上使用 A* 算法搜索房间序列。
2. **房间内层**：在单个房间内基于 CostMatrix 构建 Flow Field，由 creep 读取当前位置对应的方向并执行移动。

该模块只处理移动基础设施，不处理业务行为。搬运、采矿、战斗、升级等业务模块只调用 `goto`，并通过 options 或避让策略描述自己的移动偏好。

## 2. 设计目标

`goto` 首版完成以下能力：

- 支持同房和跨房移动。
- 支持跨房 A* 路由搜索。
- 支持按房间、按房间边界调整通行成本和通行状态，并支持**持久化到 Memory**。
- 支持有向边权重，即 A->B 与 B->A 的通行成本可独立设置。
- 支持每个房间 4 套基础 CostMatrix。
- 支持 CostMatrix 二次加工，降低热门结构周围拥堵。
- 支持基于 Flow Field 的房内移动。
- 支持强制完整建场，禁用现有流场复用。
- 支持 Flow Field 缓存、质量分数、生成时间、活跃时间和保留性评分清理。
- 支持重大 CostMatrix 更新主动失效与 Flow Field 周期性评估失效。
- 支持 creep 阻塞检测、轻量避让请求与可选避让策略注册。
- 支持 tick 间移动结果检查和 stuck 统计。
- 支持 debug 信息和可选房间可视化。

**持久化说明**：
- 用户手动定义的房间偏好、边界（有向边）偏好存储在 `Memory` 中，确保在脚本重启或 global reset 后依然有效。
- 所有的性能开销项（CostMatrix、Flow Field、跨房路由场缓存、避让请求等）只存在于 heap 中。脚本重新载入后，这些数据从空缓存开始运行，避免继承上一次 global 生命周期中的副作用。

## 3. 模块结构

```text
src/modules/goto/
  README.md
  createGoto.ts
  types.ts
  roomRoute/
    parseRoomName.ts
    createRoomGraph.ts
    findRoomExitRoute.ts
    roomExitRouteCache.ts
  costMatrix/
    createBaseCostMatrix.ts
    postProcessCostMatrix.ts
    costMatrixCache.ts
    terrainCosts.ts
  flowField/
    createFlowField.ts
    flowFieldCache.ts
    compression.ts
    reuse.ts
    reuseIndex.ts
  movement/
    goto.ts
    step.ts
    positionStore.ts
    fallback.ts
  avoidance/
    registry.ts
    requestStore.ts
    resolve.ts
  debug/
    visual.ts
    stats.ts
```

模块工厂保持当前项目的 `createXxx(context)` 风格：

```ts
export const createGoto = (context: ModuleContext, config?: GotoConfig) => {
  return {
    goto,
    onTickEnd,
    registerAvoidance,
    unregisterAvoidance,
    setRoomPreference,
    setRoomBoundaryPreference,
    updateCostMatrix,
    getDebugInfo,
  };
};
```

在 `src/app/modules.ts` 中装配：

```ts
export const goto = createGoto(createContext('Goto'));
```

## 4. 核心接口

### 4.1 GotoModule

```ts
interface GotoModule {
  goto(creep: Creep, target: GotoTarget, options?: GotoOptions): GotoResult;

  onTickEnd(): void;

  registerAvoidance(
    policyName: string,
    resolver: AvoidanceResolver
  ): void;

  unregisterAvoidance(policyName: string): void;

  setRoomPreference(roomName: string, preference: RoomPreference): void;

  setRoomBoundaryPreference(
    fromRoom: string,
    toRoom: string,
    preference: BoundaryPreference
  ): void;

  updateCostMatrix(
    roomName: string,
    options?: CostMatrixUpdateOptions
  ): void;

  getDebugInfo(): GotoDebugInfo;
}

interface CostMatrixUpdateOptions {
  reason?: string;
  critical?: boolean;
}
```

### 4.2 GotoTarget

```ts
type GotoTarget =
  | RoomPosition
  | { pos: RoomPosition }
  | { roomName: string; x: number; y: number };
```

目标支持 `RoomPosition`，也支持任何带 `pos` 的 Screeps 对象，例如 creep、structure、source、mineral、constructionSite、flag。

### 4.3 GotoOptions

```ts
interface GotoOptions {
  /** 目标范围。到达距离目标该范围内的位置即视为到达。默认为 0。 */
  range?: number;
  /** 跨房间搜索的最大房间数量。默认为 16。 */
  maxRooms?: number;
  /** 是否允许跨房间寻路。 */
  allowCrossRoom?: boolean;

  /**
   * 是否允许用现有流场构建新流场。
   * false 表示强制基于当前 CostMatrix 完整建场，生成最优 Flow Field。
   */
  reuseFlowField?: boolean;

  /**
   * 是否在 CostMatrix 中考虑 StructureRoad。
   * true 时道路 cost 低于 plain；false 时道路按普通地形处理。
   */
  considerRoads?: boolean;

  /**
   * 是否在 CostMatrix 中考虑 swamp 地形。
   * true 时 swamp cost 高于 plain；false 时 swamp 按 plain 处理。
   */
  considerSwamps?: boolean;

  /** 是否避开有敌对建筑或控制者的房间。 */
  avoidHostileRooms?: boolean;
  /** 是否在寻路时尝试避开敌对 creep。 */
  avoidHostileCreeps?: boolean;
  /** 是否避开 Source Keeper 房间。 */
  avoidKeeperRooms?: boolean;
  /** 寻路时是否忽略其它 creep。注意这不影响移动时的动态碰撞检查。 */
  ignoreCreeps?: boolean;

  /** 是否开启房间可视化渲染。 */
  visualize?: boolean;
  /** 是否开启调试日志输出。 */
  debug?: boolean;
}
```

`considerRoads` 与 `considerSwamps` 共同决定房间内基础 CostMatrix 的版本。同一个房间存在 4 套基础 CostMatrix：

```text
roads=true,  swamps=true
roads=true,  swamps=false
roads=false, swamps=true
roads=false, swamps=false
```

这 4 套 CostMatrix 面向不同角色：

- 高频搬运 creep 使用 `considerRoads=true`，强烈偏好道路。
- 需要直线穿越的战斗 creep 使用 `considerRoads=false`，避免被道路布局牵引。
- 疲劳敏感 creep 使用 `considerSwamps=true`，规避沼泽。
- 对路径长度更敏感的 creep 使用 `considerSwamps=false`，将沼泽视为普通地形。

`reuseFlowField=false` 用于强制建立最优场。该选项用于高价值移动、战斗移动、卡住后的重建，以及 debug 对比。

### 4.4 GotoResult

```ts
interface GotoResult {
  code: ScreepsReturnCode;
  moved: boolean;
  arrived: boolean;
  blocked: boolean;
  requestedAvoidance: boolean;
  usedCache: boolean;
  reusedFlowField: boolean;
  pathType: 'flowField' | 'pathFinder' | 'fallback' | 'none';
  reason?: string;
}
```

上层行为通过 `GotoResult` 判断移动是否完成、是否被阻塞、是否已经请求避让、是否使用了缓存或复用流场。

## 5. 跨房间寻路

### 5.1 房间图

跨房间寻路使用房间作为节点，相邻房间之间的出口作为边：

```ts
interface RoomEdge {
  from: string;
  to: string;
  direction: DirectionConstant;
  cost: number;
  passable: boolean;
}
```

边成本由以下因素构成：

- 基础移动成本。
- 目标房间偏好。
- 房间边界偏好。
- 房间类型成本，包括 highway、source keeper、center room、owned room、reserved room、enemy room。
- Intel 信息，包括敌对建筑、tower、入侵者、封锁出口。
- 近期 stuck 或移动失败统计。

### 5.2 A* 搜索

A* 使用房间坐标的曼哈顿距离作为启发函数：

```text
h(room, targetRoom) = abs(room.x - target.x) + abs(room.y - target.y)
```

房间名解析使用 Screeps 坐标规则：

```text
W0N0 -> (-1, -1)
E0N0 -> (0, -1)
W0S0 -> (-1, 0)
E0S0 -> (0, 0)
```

W/E 与 N/S 边界不存在 `-0` 房间。解析与反解析必须使用同一套规则，避免跨越 `W0/E0` 或 `N0/S0` 时出现偏移。

### 5.3 房间偏好

用户可以通过接口设置房间或边界的通行权重，这些信息将持久化存储在 `Memory` 中。

```ts
interface RoomPreference {
  /** 是否可通行。false 时寻路算法将完全避开该房间。 */
  passable?: boolean;
  /** 通行成本倍率。默认 1.0。 */
  cost?: number;
  /** 是否尽量避开。 */
  avoid?: boolean;
  reason?: string;
}

interface BoundaryPreference {
  /** 该方向是否可通行。 */
  passable?: boolean;
  /** 该方向的通行成本权重。 */
  cost?: number;
  reason?: string;
}
```

房间偏好描述某个房间整体是否可走、是否危险、是否应尽量绕开。

**有向边界偏好**描述从房间 A 到房间 B 的特定出口是否可走。存储在 Memory 中时，以 `${fromRoom}->${toRoom}` 作为 key，实现非对称的通行控制。

### 5.4 跨房路由场缓存

跨房 A* 仍然搜索完整房间序列，但缓存不保存整条路线，而是保存类似 Flow Field 的房间级路由场。路由场记录“为了抵达某个目标房间，某个房间内的 creep 应该走向哪个出口方向”。

跨房路由场缓存只存在于 heap：

```ts
interface CachedRoomExitRoute {
  roomName: string;
  targetRoom: string;
  avoidHostileRooms: boolean;
  exitDirection: ExitConstant;
  nextRoom: string;
  createdAt: number;
  lastUsed: number;
  preferenceVersion: number;
  routeCost: number;
}
```

缓存 key：

```text
targetRoom + avoidHostileRooms + roomName
```

缓存值示例：

```text
W22N11:5
```

表示当目标房间为当前路由场的 `targetRoom` 时，creep 位于 `W22N11` 应向 `5` 对应的出口方向移动。`nextRoom` 用于记录该出口方向后的目标房间，并支持边界失败统计。

失效条件：

- 房间偏好变化。
- 边界偏好变化。
- Intel 危险等级变化。
- 路由中的房间或边界产生连续移动失败。

## 6. CostMatrix

### 6.1 CostMatrix 分类

CostMatrix 由以下维度决定：

```text
roomName
considerRoads
considerSwamps
eventStamp
```

同一个房间维护 4 套基础 CostMatrix，对应 `considerRoads` 与 `considerSwamps` 的四种组合。

### 6.2 CostMatrix 事件戳

每个房间维护一个 CostMatrix 事件戳：

```ts
interface RoomCostMatrixStamp {
  roomName: string;
  eventStamp: number;
  updatedAt: number;
  reason?: string;
}
```

当房间内影响通行的静态或半静态信息变化时，`eventStamp` 递增：

- 建筑建成。
- 建筑消失或被摧毁。
- constructionSite 创建、完成或删除。
- rampart public/private 状态变化。
- 房间控制权变化。
- source keeper lair、hostile structure 等危险信息变化。
- 手动调用 `updateCostMatrix(roomName, options)`。

CostMatrix 缓存值记录生成时的 `eventStamp`：

```ts
interface CachedCostMatrix {
  matrix: CostMatrix;
  roomName: string;
  considerRoads: boolean;
  considerSwamps: boolean;
  eventStamp: number;
  createdAt: number;
  lastUsed: number;
}
```

当缓存中的 `eventStamp` 小于房间当前 `eventStamp` 时，该 CostMatrix 过期并被丢弃。

外部通行环境变化统一通过 `updateCostMatrix` 通知 goto：

```ts
goto.updateCostMatrix(roomName, {
  reason: 'structureChanged',
  critical: true,
});
```

调用该方法时，模块递增本房间 `eventStamp`，并清理该房间旧版本 CostMatrix。`critical=true` 表示重大更新，例如建筑阻挡、rampart 状态、房间控制权、危险结构等足以改变已有方向场正确性的变化；模块会立即清空本房间 Flow Field 缓存。`critical` 通常由 `goto` 监听事件后自行判断，调用方只需要在手动维护通行状态时显式传入。

### 6.3 基础构建规则

基础 CostMatrix 处理地形和道路：

```text
wall terrain: 255
plain: 2
swamp:
  considerSwamps=true: 10
  considerSwamps=false: 2
road:
  considerRoads=true: 1
  considerRoads=false: 按所在地形处理
```

当前版本不引入额外 `matrixProfile` 维度。不同角色的移动偏好通过 `considerRoads` 与 `considerSwamps` 两个选项表达；后续如需支持 combat、dismantler 等特殊成本模型，再扩展独立 profile 维度。

### 6.4 二次加工

基础 CostMatrix 生成后进入二次加工步骤。二次加工负责写入建筑阻挡、热门结构周围拥堵惩罚和特殊区域成本。

不可通行建筑所在格设置为 `255`：

```text
StructureSpawn
StructureExtension
StructureLink
StructureStorage
StructureTower
StructureObserver
StructurePowerSpawn
StructureExtractor
StructureLab
StructureTerminal
StructureNuker
StructureFactory
StructureInvaderCore
非己方或不可通行 StructureRampart
其它 blocking structure
```

可通行或场景相关结构按基础规则处理：

```text
StructureRoad: 由 considerRoads 决定
StructureContainer: 默认可通行，但 cost 高于 road/plain
己方可通行 rampart: 默认可通行
constructionSite: 按结构类型判断
```

热门结构周围增加拥堵成本。热门结构包括：

```text
Source
Mineral
StructureStorage
StructureTerminal
StructureSpawn
Controller
常用 link/container
```

拥堵成本按半径衰减：

```text
range 1: +8
range 2: +4
range 3: +2
```

该步骤让普通路径倾向于绕开热门结构周围区域，避免 creep 穿过 source、mineral、storage、spawn 等高频作业点附近，降低局部交通拥堵。目标本身位于热门结构附近时，最终目标 range 内的格子不额外惩罚，避免导致无法靠近目标。

### 6.5 CostMatrix 缓存

CostMatrix 缓存只存在 heap 中：

```ts
type CostMatrixKey =
  `${string}:roads=${boolean}:swamps=${boolean}:stamp=${number}`;
```

清理规则：

- `eventStamp` 过期立即清理。
- 长时间未使用的 CostMatrix 按 `lastUsed` 清理。
- heap 缓存数量超过上限时，优先删除低频房间。

## 7. Flow Field

### 7.1 基本结构

Flow Field 是房间内从任意格走向目标的方向场。它基于某个 CostMatrix 构建，并与该 CostMatrix 的 `eventStamp` 绑定。

```ts
interface FlowField {
  roomName: string;
  targetKey: string;
  range: number;
  considerRoads: boolean;
  considerSwamps: boolean;
  costMatrixEventStamp: number;
  createdAt: number;
  activeAt: number;
  score: number;
  retentionScore: number;
  buildType: 'full' | 'reused' | 'partial';
  reusedFrom?: string;
  reusedDepth?: number;
  patch?: ReusedFlowFieldPatch;
  data?: Uint8Array;
}
```

`data` 使用 `Uint8Array` 存储压缩后的完整方向数据。完整建场直接读取 `data`；复用建场可以不复制完整 `data`，而是通过 `patch` 覆盖局部差异区域，patch 外读取 `reusedFrom` 指向的基础 Flow Field。每个格子只需要保存一个方向值：

```text
0: unreachable / none
1-8: Screeps direction
```

首版使用 `Uint8Array(length = 2500)`，每格一个 byte。压缩层保留 nibble 编码扩展点，后续版本在不改变外部接口的前提下切换为每 byte 存两个格子的方向值。

Flow Field 不写入 `Memory`。global reset 后所有 Flow Field 缓存消失。

### 7.2 生成流程

Flow Field 以目标范围内的所有可接受格为起点，反向扩散生成：

```text
1. 解析 target + range，得到目标房间内所有可接受终点格。
2. 读取或创建匹配 options 的 CostMatrix。
3. 将终点格 distance 设为 0，放入优先队列。
4. 使用 Dijkstra 在 50x50 网格反向扩散。
5. 每次更新相邻格最短距离时，记录该格应该移动的 DirectionConstant。
6. 构建完成后，丢弃 distance field，仅保留 Uint8Array 方向场。
```

完整建场得到最优 Flow Field，初始质量分数为 `100`。

成本语义：

- 从 `pos` 走向 `next` 的移动代价为 `costMatrix.get(next.x, next.y)`。
- 8 个方向的方向成本相同，不对斜向移动额外加权。
- 允许对角移动，只要目标格在 CostMatrix 中可通行。
- 多目标 range 内的终点格以 CostMatrix 呈现的信息为准，`255` 或不可接受成本的格子不会作为终点。

### 7.3 跨房衔接

跨房移动通过路由场被拆为房间内 segment：

```ts
interface RouteSegment {
  roomName: string;
  target:
    | { type: 'position'; pos: RoomPosition; range: number }
    | { type: 'exit'; direction: DirectionConstant; nextRoom: string };
}
```

当目标房间不是当前房间时，`goto` 先查询或生成跨房路由场，得到当前房间应该前往的出口方向。随后使用该出口方向查询或生成当前房间内的出口 Flow Field。

中间房间的 Flow Field 目标是下一房间方向上的可通行出口格：

```text
TOP: y = 0
BOTTOM: y = 49
LEFT: x = 0
RIGHT: x = 49
```

出口格必须通过 CostMatrix 过滤。不可通行出口不会进入目标集合。

### 7.4 流场复用

`GotoOptions.reuseFlowField` 控制是否允许复用现有流场建场。

```text
reuseFlowField=true:
  没有精确匹配流场时，选择高质量相近流场进行局部建场。

reuseFlowField=false:
  必须基于当前 CostMatrix 完整建场。
  生成结果是 full Flow Field。
```

#### 7.4.1 复用候选索引

为了避免每次建场时遍历本房间所有 Flow Field，模块维护独立的复用候选索引。只有满足资格条件的 Flow Field 会进入索引：

- `score >= minReusableScore`。
- 保留性指标未低于清理阈值。
- `reusedDepth < maxReuseDepth`。
- 与新目标使用同一个房间、`considerRoads`、`considerSwamps` 和 CostMatrix 版本。
- 目标类型兼容。普通位置目标只复用普通位置目标场；出口目标按出口方向分组。

低于复用分数阈值的 Flow Field 不进入索引，也不会在查询候选时被扫描。

索引使用目标位置的空间哈希：

```text
bucketSize = 5 或 10
bucketX = floor(target.x / bucketSize)
bucketY = floor(target.y / bucketSize)
bucketKey = roomName + roadsKey + swampsKey + targetType + bucketX + bucketY
```

查找候选时，从新目标所在 bucket 开始，按半径扩展查询附近 bucket，并只保留前 `maxReuseCandidates` 个候选。最终候选再按精确评分排序：

```ts
interface FlowFieldScoreInput {
  sourceScore: number;
  targetDistance: number;
  sourceAge: number;
  reusedDepth: number;
}
```

初始评分公式：

```text
reuseScore = sourceScore
  - targetDistance * 4
  - reusedDepth * 10
  - agePenalty
```

当最高评分低于阈值时，不复用，改为完整建场。

```ts
interface FlowFieldReuseConfig {
  minReusableScore: number;
  minReuseScore: number;
  maxTargetDistance: number;
  maxReuseCandidates: number;
  bucketSize: number;
  maxReuseDepth: number;
  maxPatchCells: number;
}
```

#### 7.4.2 边界收敛式局部复用

复用建场不尝试从旧方向场直接推导完整新方向场，而是使用 **边界收敛式局部复用**。

设旧 Flow Field 为 `T`，旧目标为 `P`；新 Flow Field 为 `T'`，新目标为 `P'`。两者必须使用同一个 CostMatrix `C`。算法从 `P'` 开始反向 Dijkstra，只生成 `T'` 与 `T` 不同的差异区域；当扩散到某个位置后，新方向与旧方向收敛，并且该方向的后继路径已经接入新场可信区域时，将该位置作为边界，边界外继续复用 `T`。

生成流程：

```text
1. 将 P' 的可接受终点格压入优先队列，distance = 0。
2. 使用 CostMatrix C 反向 Dijkstra，逐步生成新距离场 D'。
3. 每次确定某个位置 pos 的 T'[pos] 后，与 T[pos] 比较。
4. 如果 T'[pos] 与 T[pos] 不同，pos 属于差异区域，继续向外扩散。
5. 如果 T'[pos] 与 T[pos] 相同，还需要检查 next(pos, T[pos]) 是否已经接入可信区域。
6. 通过检查后，pos 成为复用边界，不再从 pos 向外扩散。
7. 扩散直到所有外沿都被复用边界闭合。
```

可信区域包括：

- 新目标 `P'` 的可接受终点格。
- 已生成并确认属于差异区域的 `T'` 格。
- 已确认的复用边界格。

边界判断不能只比较当前格方向是否相同，还必须保证后继路径可接入新场：

```text
isConverged(pos):
  T'[pos] == T[pos]
  and next(pos, T[pos]) is trusted
```

这样可以避免某个格子的第一步方向虽然相同，但后续进入旧场后仍被带回旧目标 `P`。

复用结果保存为旧场加局部覆盖层：

```ts
interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface ReusedFlowFieldPatch {
  baseFieldId: string;
  targetKey: string;
  range: number;
  bounds: Rect;
  directions: Uint8Array;
  trusted: Uint8Array;
  reusedDepth: number;
}
```

读取方向时：

```text
当前位置在 patch bounds 内且 patch 有方向：读取 patch direction。
否则：读取 base Flow Field direction。
```

边界收敛式复用失败时，必须回退完整建场。失败条件包括：

- 新目标与旧目标距离超过 `maxTargetDistance`。
- 扩散格数超过 `maxPatchCells`。
- 无法形成可信闭合边界。
- 扩散触及房间边界或不可达区域后仍无法收敛。
- patch 质量评分低于 `minReuseScore`。

复用流场不保证全局最优，因此复用结果质量分数低于完整建场。复用深度越高、patch 越大、目标距离越远，质量分数越低，也越容易在周期性保留性评估中被清理。

### 7.5 失效与保留性评估机制

Flow Field 使用两类失效机制：

1. **重大 CostMatrix 更新主动失效**。
2. **周期性保留性评估失效**。

CostMatrix 更新失效规则：

```text
updateCostMatrix(roomName, { critical: true })
  -> increment room costMatrix eventStamp
  -> delete room costMatrix cache
  -> delete room flowField cache
```

`goto` 监听房间内建筑和房间状态事件，并在模块内部判断本次 CostMatrix 更新是否属于重大更新。调用方通常不需要手动判断 `critical`。

模块维护一组会影响通行性的结构类型和状态规则。当这些对象发生变化时，本房间更新视为 `critical=true`。典型情况包括：

- 不可通行建筑建造完成、消失或被摧毁。
- 非己方或不可通行 rampart 状态变化。
- 房间控制权变化。
- hostile structure、invader core、source keeper lair 等危险结构信息变化。
- 一批道路建设完成时，本批次最后一条道路建成。

道路建设不要求每条道路完成都立即清空 Flow Field。模块可以按房间记录待处理道路建设状态，仅在本批次道路全部完成后触发一次重大更新，降低重建震荡。

`critical=false` 或未传入时，只递增本房间 CostMatrix `eventStamp` 并清理旧 CostMatrix。适用于拥堵统计、偏好成本、软危险成本等不立即破坏方向场可用性的更新。此时既有 Flow Field 可以继续使用，后续由周期性保留性评估决定是否清理。

由于重大更新已经在 `updateCostMatrix` 入口完成 Flow Field 清理，主流程能读取到的 Flow Field 都被视为具备使用条件。主流程不做每 tick 的 Flow Field 与 CostMatrix eventStamp 强制比较。

周期性保留性评估由未来的周期任务管理模块调用。该任务扫描 Flow Field 缓存，根据质量分数、生成时间、活跃时间、复用深度和 patch 大小计算保留性指标。当指标低于配置阈值时清理该缓存。

```ts
interface FlowFieldRetentionConfig {
  minRetentionScore: number;
  agePenaltyPerTick: number;
  inactivePenaltyPerTick: number;
  activeBonus: number;
  reusedDepthPenalty: number;
  patchSizePenalty: number;
}
```

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

完整建场的初始质量分数高于复用建场。复用建场由于可能非最优，会带有更高的复用深度和 patch 惩罚，因此更容易在周期任务中被清理。

每次流场被调用后刷新 `activeAt`：

```text
flowField.activeAt = Game.time
```

缓存清理优先级：

1. 重大 CostMatrix 更新直接清理的房间流场。
2. 保留性指标低于阈值的复用流场。
3. 保留性指标低于阈值的完整流场。
4. 缓存数量超过上限时，按保留性指标从低到高清理。

## 8. creep 阻塞与避让

### 8.1 动态阻塞

creep 不进入长期 CostMatrix，也不触发 CostMatrix 失效。实际移动前对推荐方向的目标格进行动态检查：

```text
1. 目标格无 creep：直接移动。
2. 目标格有 creep：尝试本地绕行。
3. 本地绕行不可用：创建避让请求或返回 blocked。
4. 连续 stuck：强制完整建场或 fallback 到 PathFinder。
```

### 8.2 避让请求

```ts
interface AvoidanceRequest {
  id: string;
  tick: number;
  requesterName: string;
  blockerName: string;
  from: RoomPosition;
  blockedPos: RoomPosition;
  desiredDirection: DirectionConstant;
  priority: number;
  reason?: string;
}
```

避让请求只存在当前 global 的 heap 中，并在 tick 结束时清理过期请求。

### 8.3 避让策略

```ts
type AvoidanceDecision =
  | { type: 'accept'; direction?: DirectionConstant }
  | { type: 'reject'; reason?: string }
  | { type: 'defer'; reason?: string };

type AvoidanceResolver = (
  creep: Creep,
  request: AvoidanceRequest,
  context: AvoidanceContext
) => AvoidanceDecision;

interface AvoidanceContext {
  pendingMoves: ReadonlyMap<string, PendingMove>;
  requests: readonly AvoidanceRequest[];
  findSafeDirections(creep: Creep): DirectionConstant[];
  isReserved(pos: RoomPosition): boolean;
}
```

`goto` 提供避让请求、候选方向和安全性判断。首版仍然采用调用时立即 `move` 的模型，不引入两阶段 intent 调度。因此，当两个正在赶路的 creep 同 tick 争抢同一地块时，后调用或被挡住的 creep 可能停留 1 tick；该代价在首版中视为可接受。

避让请求主要用于可选的轻量协作：被阻塞 creep 可以发出请求，挡路 creep 在其后续 tick 或后续行为调用中结合 resolver 决定是否让路。首版不保证同 tick 内完成全局最优避让，也不处理所有互相让路循环。

候选避让方向过滤条件：

- 目标格可通行。
- 目标格未被其它 creep 预定。
- 不进入危险区域。
- 不离开当前房间，除非策略允许。
- 不明显远离自身目标。
- 不阻塞更多高优先级 creep。

### 8.4 移动结果检查

每次成功调用 `move` 后记录 PendingMove：

```ts
interface PendingMove {
  creepName: string;
  tick: number;
  from: PackedPos;
  expected: PackedPos;
  direction: DirectionConstant;
  targetKey?: string;
}
```

下一 tick 检查 creep 是否到达 `expected`。未到达时增加 stuck 计数；移动成功时清理或降低 stuck 计数。

stuck 计数触发以下动作：

- 重新读取 Flow Field。
- 禁止复用流场并强制完整建场。
- 短期使用 PathFinder fallback。
- 对相关房间边界或流场记录失败统计。

## 9. goto 主流程

```text
1. 标准化 target 与 options。
2. 判断 creep 是否已在 range 内。
3. 读取 creep 的移动状态和 stuck 计数。
4. 根据目标房间判断是否需要跨房路由。
5. 如果目标在当前房间，当前 RouteSegment 为最终目标。
6. 如果目标不在当前房间，获取或计算跨房路由场，并读取当前房间的出口方向。
7. 将出口方向转换为当前房间的出口 RouteSegment。
8. 按 considerRoads + considerSwamps 获取 CostMatrix。
9. CostMatrix 不存在或版本已更新时重建 CostMatrix。
10. 获取匹配且保留性有效的 Flow Field。
11. 如果无匹配 Flow Field：
    11.1 reuseFlowField=true 时从复用索引查询高质量相近流场。
    11.2 对候选场尝试边界收敛式局部复用。
    11.3 reuseFlowField=false 或复用失败时完整建场。
12. 从 Flow Field 读取当前位置方向。
13. 检查目标格动态阻塞。
14. 无阻塞时执行 creep.move(direction)。
15. 有阻塞时尝试轻量绕行。
16. 绕行失败时创建 AvoidanceRequest 或返回 blocked。
17. 记录 PendingMove。
18. 返回 GotoResult。
```

## 10. fallback

fallback 用于保证模块在缓存失效、流场构建失败或特殊地形中仍能移动：

1. Flow Field 不可用时，使用 `PathFinder.search` 到当前 segment 目标。
2. PathFinder 失败时，重新计算跨房路由场。
3. 仍失败时返回结构化错误，避免同 tick 重复消耗 CPU。

fallback 路径只做短期 heap 缓存，并且不写入 Memory。

## 11. 缓存与持久化管理

### 11.1 缓存范围 (Heap)

模块维护以下 heap 缓存，脚本重载后清空：

- `roomRouteCache`
- `costMatrixCache`
- `flowFieldCache`
- `flowFieldReuseIndex`
- `pendingMoves`
- `avoidanceRequests`
- `blockedStats`
- `debugStats`

### 11.2 持久化数据 (Memory)

以下数据存储在 `Memory` 中，用于跨 global 生命周期保留用户配置：

- `roomPreferences`: 房间通行成本与可见性偏好。
- `boundaryPreferences`: 房间间有向边的通行偏好。

### 11.3 缓存上限与清理

```ts
interface CacheLimits {
  maxRoomExitRoutes: number;
  maxCostMatrices: number;
  maxFlowFields: number;
  maxAvoidanceRequests: number;
}
```

清理顺序：

1. 删除保留性指标低于阈值的 Flow Field。
2. 删除事件戳落后的 CostMatrix。
3. 删除低分且长时间未活跃的 Flow Field。
4. 删除最久未使用的跨房路由场。
5. 删除低频房间的 CostMatrix。

### 11.4 CPU 预算

同一 tick 内限制新建 CostMatrix 和 Flow Field 的数量。超过预算后，模块使用 fallback 或延迟建场。

```ts
interface BuildBudget {
  maxCostMatricesPerTick: number;
  maxFlowFieldsPerTick: number;
  maxRoomExitRoutesPerTick: number;
}
```

## 12. Debug 与可观测性

```ts
interface GotoDebugInfo {
  roomExitRoutesBuilt: number;
  costMatricesBuilt: number;
  flowFieldsBuilt: number;
  flowFieldsReused: number;
  flowFieldsInvalidatedByCostMatrixUpdate: number;
  flowFieldsEvictedByRetention: number;
  cacheHits: number;
  cacheMisses: number;
  stuckEvents: number;
  avoidanceRequests: number;
  cpuUsed: number;
}
```

可视化内容：

- 当前 creep 推荐方向。
- 当前 RouteSegment 目标。
- 跨房路由场出口方向。
- Flow Field 方向采样。
- stuck 状态。
- 避让请求。
- CostMatrix 高成本区域。

可视化只在 `visualize=true` 时执行。

## 13. 与当前项目集成

`goto` 复用当前项目基础设施：

- 使用 `ModuleContext.env` 访问 `Game`、`Room`、`getObjectById` 和日志。
- **Memory 挂载**：模块需要访问 `Memory.goto`（或其它指定位置）以读写持久化的房间与边界偏好。
- 使用 `bus.subscribe` 监听建筑相关事件，并由模块内部判断是否调用 `updateCostMatrix(roomName, { critical: true })`；重大通行变化由入口清理本房间 Flow Field。
- 使用 `profiler.wrap` 包裹 A*、CostMatrix 构建、Flow Field 构建等高 CPU 函数。
- 使用 `src/utils/priorityQueue.ts` 实现 A* 与 Dijkstra。

`onTickEnd()` 完成以下工作：

- 检查 PendingMove。
- 清理过期 AvoidanceRequest。
- 清理保留性指标低于阈值的 Flow Field。
- 清理事件戳落后的 CostMatrix。
- 更新 debug 统计。

## 14. 开发计划

首版一次完成完整能力：

1. 定义 `types.ts`。
2. 实现 `createGoto` 与模块装配。
3. 实现房间名解析、房间图和跨房 A*。
4. 实现房间偏好与边界偏好。
5. 实现 4 套 CostMatrix 构建规则。
6. 实现 CostMatrix 二次加工。
7. 实现 CostMatrix heap 缓存、事件戳与 `updateCostMatrix` 更新入口。
8. 实现完整 Flow Field 构建。
9. 实现 Flow Field `Uint8Array` 存储。
10. 实现 Flow Field heap 缓存、质量分数、保留性评分和活跃时间清理。
11. 实现 `reuseFlowField` 控制、复用候选索引与边界收敛式局部复用建场。
12. 实现 `goto(creep, target, options)` 主流程。
13. 实现动态阻塞检查、本地绕行和避让请求。
14. 实现可选避让策略注册与 resolver 调用。
15. 实现 PendingMove、stuck 检查和强制重建。
16. 实现 fallback PathFinder。
17. 实现 debug 信息与可选 visual。
18. 编写核心单元测试和模拟场景测试。

首版验收标准：

- creep 能在同房间使用 Flow Field 到达目标。
- creep 能跨房间到达目标。
- `considerRoads` 与 `considerSwamps` 能生成 4 套不同 CostMatrix。
- 不可通行建筑被正确阻挡。
- Source、Mineral、Storage、Spawn 等热门结构周围路径成本被抬高。
- `reuseFlowField=false` 时强制完整建场。
- 复用候选查询不会遍历本房间所有 Flow Field。
- 目标相近时能通过边界收敛式局部复用生成 patch。
- 边界收敛失败时能回退完整建场。
- `updateCostMatrix(..., { critical: true })` 后本房间旧流场失效。
- Flow Field 保留性指标低于阈值后失效。
- 活跃流场不会被优先清理。
- global reset 后没有 Memory 缓存副作用。
- 被阻塞 creep 能发出避让请求。
- stuck 后能触发重建或 fallback。

## 15. 关键风险

- 出口 Flow Field 通过跨房路由场统一选择出口方向，但仍需要避免 creep 在疲劳、阻塞或路由场刚更新时在房间边界来回横跳。
- 热门结构周围加权不能导致目标不可达。
- `updateCostMatrix` 必须覆盖所有影响通行的变化，重大变化必须由模块内部判断为 `critical=true`。
- 复用流场可能非最优，必须受 `reuseFlowField`、质量分数、复用深度和 patch 大小约束。
- 边界收敛式复用必须保证边界后继路径接入可信区域，否则可能把 creep 带回旧目标。
- 首版不做两阶段移动调度，两个赶路 creep 争抢同一地块时可能有 1 tick 停顿；该代价被视为可接受。
- 同 tick 大量新目标可能造成建场峰值，需要 build budget 限制。
- heap-only 缓存会在 global reset 后冷启动，首批移动需要 fallback 和预算保护。

## 16. 术语

- **Room Exit Route**：跨房路由场中的单房间出口指令，表示为了抵达目标房间，当前房间应走向哪个出口方向。
- **Route Segment**：当前房间内的局部目标，可能是最终目标，也可能是出口。
- **CostMatrix**：房间内静态和半静态通行成本。
- **CostMatrix Event Stamp**：房间通行环境变化时递增的事件戳。
- **Flow Field**：从任意格到目标的方向场。
- **Full Flow Field**：基于当前 CostMatrix 完整计算得到的最优方向场。
- **Reused Flow Field**：基于已有流场局部生成的方向场。
- **Retention Score**：Flow Field 的保留性指标，由质量分数、生成时间、活跃时间、复用深度和 patch 大小共同决定。
- **Avoidance Request**：一个 creep 请求另一个 creep 让路的协调消息。
- **PendingMove**：上 tick 的移动意图记录，用于下 tick 检查移动是否成功。
