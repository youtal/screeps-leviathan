import type { ModuleContext } from '@/core/runtime/types';

/**
 * goto 可以接受的目标形态。
 *
 * 业务模块通常不应该为了移动而手动拆解目标对象；采矿、搬运、升级等行为
 * 往往天然持有 Source、Structure、Controller、Flag 或 RoomPosition。
 * 因此这里支持两类输入：
 * - RoomPosition：最直接的房间坐标。
 * - 带 pos 的对象：覆盖大多数 Screeps 房间对象。
 * - 轻量坐标对象：便于测试、序列化或从 Memory 中还原目标。
 */
export type GotoTarget =
  | RoomPosition
  | { pos: RoomPosition }
  | { roomName: string; x: number; y: number };

/**
 * Flow Field 的来源类型。
 *
 * full 表示基于当前 CostMatrix 完整 Dijkstra 建场，是质量最高、语义最稳的结果。
 * reused 表示基于已有场做局部 patch，CPU 更省，但需要分数和深度约束。
 * partial 预留给未来预算不足时的分段建场或渐进式建场。
 */
export type FlowFieldBuildType = 'full' | 'reused' | 'partial';

/**
 * 本次 goto 最终使用的移动决策来源。
 *
 * 这个字段用于上层调试和统计：正常情况下应优先是 flowField；
 * 当建场失败、预算不足或遇到异常地形时，会退到 PathFinder 或更轻量 fallback。
 */
export type GotoPathType = 'flowField' | 'pathFinder' | 'fallback' | 'none';

/**
 * 单次移动调用的行为选项。
 *
 * 这些选项描述的是“本次移动偏好”，而不是模块级永久配置。
 * 其中 considerRoads + considerSwamps 共同决定房内 CostMatrix 的基础版本；
 * 当前设计刻意不引入 matrixProfile，避免首版过早膨胀出太多缓存维度。
 */
export interface GotoOptions {
  /** 到目标该范围内即视为到达。 */
  range?: number;
  /** 跨房 A* 最多允许展开的房间数量。 */
  maxRooms?: number;
  /** 是否允许跨房移动；关闭后目标不在当前房间会直接失败或 fallback。 */
  allowCrossRoom?: boolean;
  /** 是否允许使用已有 Flow Field 生成复用场。false 会强制完整建场。 */
  reuseFlowField?: boolean;
  /** 是否在 CostMatrix 中把道路作为低成本地块处理。 */
  considerRoads?: boolean;
  /** 是否在 CostMatrix 中把 swamp 作为高成本地块处理。 */
  considerSwamps?: boolean;
  /** 跨房路由时是否避开包含敌对建筑或敌对控制信息的房间。 */
  avoidHostileRooms?: boolean;
  /** 房内移动时是否尽量避开敌对 creep。 */
  avoidHostileCreeps?: boolean;
  /** 跨房路由时是否避开 Source Keeper 房间。 */
  avoidKeeperRooms?: boolean;
  /** 寻路阶段是否忽略 creep；实际 move 前仍会做动态阻塞检查。 */
  ignoreCreeps?: boolean;
  /** 是否绘制本次移动相关 visual。 */
  visualize?: boolean;
  /** 是否输出本次移动相关 debug 日志。 */
  debug?: boolean;
}

/**
 * goto 的结构化返回结果。
 *
 * 上层行为不需要猜测 move 返回码背后的上下文，而是可以直接判断：
 * - arrived：本 tick 调用前是否已经在目标范围内。
 * - moved：是否已经成功提交 creep.move。
 * - blocked：是否被动态阻塞挡住。
 * - requestedAvoidance：是否已经发出让路请求。
 */
export interface GotoResult {
  code: ScreepsReturnCode;
  moved: boolean;
  arrived: boolean;
  blocked: boolean;
  requestedAvoidance: boolean;
  usedCache: boolean;
  pathType: GotoPathType;
  reason?: string;
}

/**
 * goto 模块暴露给业务层的公共能力。
 *
 * 模块边界刻意保持在“移动基础设施”层：
 * - goto 执行单个 creep 的移动决策。
 * - onTickEnd 做 tick 末维护，如 PendingMove 检查和缓存清理。
 * - preference 接口写入 Memory，表达长期通行偏好。
 * - updateCostMatrix 是通行环境变化的统一入口。
 */
export interface GotoModule {
  goto(
    creep: Creep | PowerCreep,
    target: GotoTarget,
    options?: GotoOptions
  ): GotoResult;
  onTickEnd(): void;
  registerAvoidance(policyName: string, resolver: AvoidanceResolver): void;
  unregisterAvoidance(policyName: string): void;
  setRoomPreference(roomName: string, preference: RoomPreference): void;
  setRoomBoundaryPreference(
    fromRoom: string,
    toRoom: string,
    preference: BoundaryPreference
  ): void;
  getDebugInfo(): GotoDebugInfo;
}

/**
 * goto 模块级配置。
 *
 * defaults 是 GotoOptions 的默认值集合；调用 goto 时传入的 options 会覆盖它。
 * 其它配置用于控制缓存规模、单 tick 建场预算、Flow Field 复用和保留性评分。
 * 这些值属于代码配置，不写入 Memory；global reset 后可以从工厂参数重新生成。
 */
export interface GotoConfig {
  defaults?: Required<
    Pick<
      GotoOptions,
      | 'range'
      | 'maxRooms'
      | 'allowCrossRoom'
      | 'reuseFlowField'
      | 'considerRoads'
      | 'considerSwamps'
      | 'avoidHostileRooms'
      | 'avoidHostileCreeps'
      | 'avoidKeeperRooms'
      | 'ignoreCreeps'
      | 'visualize'
      | 'debug'
    >
  >;
  cacheLimits?: Partial<CacheLimits>;
  buildBudget?: Partial<BuildBudget>;
  flowFieldReuse?: Partial<FlowFieldReuseConfig>;
  flowFieldRetention?: Partial<FlowFieldRetentionConfig>;
}

/**
 * goto 使用的上下文。
 *
 * 默认情况下实现可以直接使用全局 Memory.goto；getMemory 允许测试或特殊装配
 * 注入另一块持久化区域，从而避免测试之间互相污染。
 */
export interface GotoContext extends ModuleContext {
  getMemory?: () => GotoMemory;
}

/**
 * goto 唯一写入 Memory 的数据。
 *
 * 这里故意只保存用户偏好，不保存 CostMatrix、Flow Field、路由场或避让请求。
 * 这些运行期缓存依赖当前 global 生命周期，持久化它们容易继承过期地形、
 * 旧敌情或旧堵塞状态，反而让移动系统变得不可解释。
 */
export interface GotoMemory {
  roomPreferences?: Record<string, RoomPreference>;
  boundaryPreferences?: Record<string, BoundaryPreference>;
}

/**
 * 通知房间通行成本发生变化时使用的选项。
 *
 * critical 表示这次变化足以破坏已有 Flow Field 的方向正确性，例如阻挡建筑、
 * rampart 通行状态或房间控制权变化。非 critical 更新只清理 CostMatrix，
 * 既有 Flow Field 交给周期性保留性评分自然淘汰。
 */
export interface CostMatrixUpdateOptions {
  reason?: string;
  critical?: boolean;
}

/**
 * Screeps 房间名解析后的连续坐标。
 *
 * 解析规则必须遵守 W0/E0 与 N0/S0 的边界语义：
 * W0N0 -> (-1, -1)，E0S0 -> (0, 0)。
 * 这让跨象限的 A* 可以用普通曼哈顿距离做启发函数。
 */
export interface RoomCoordinate {
  roomName: string;
  x: number;
  y: number;
}

/**
 * 房间图中的一条有向边。
 *
 * Screeps 房间相邻关系看似无向，但实际移动成本需要支持 A->B 与 B->A 不同：
 * 出口封锁、敌方 tower 覆盖、近期边界失败统计都可能只影响一个方向。
 */
export interface RoomEdge {
  from: string;
  to: string;
  direction: ExitConstant;
  cost: number;
  passable: boolean;
}

/**
 * 用户对某个房间整体通行性的长期偏好。
 *
 * passable=false 会让跨房 A* 完全避开该房间；cost 是倍率或权重；
 * avoid 是更温和的“能绕就绕”，用于危险但不是绝对禁区的房间。
 */
export interface RoomPreference {
  passable?: boolean;
  cost?: number;
  avoid?: boolean;
  reason?: string;
}

/**
 * 用户对某条房间边界的长期偏好。
 *
 * key 由实现层使用 `${fromRoom}->${toRoom}` 组织，因此天然是有向的。
 * 这可以表达“从敌房撤退可走、从己房主动进入不可走”一类非对称策略。
 */
export interface BoundaryPreference {
  passable?: boolean;
  cost?: number;
  reason?: string;
}

/**
 * 跨房路由场中的单房间出口指令。
 *
 * A* 仍然会计算完整房间序列，但缓存形态不是“从起点到终点的一整条路线”，
 * 而是“为了抵达 targetRoom，当前 roomName 应该走哪个出口”。
 * 这种形态更接近房间级 Flow Field，多 creep 从不同房间去同一目标房间时
 * 可以共享缓存，并且更容易在中途房间复用。
 */
export interface CachedRoomExitRoute {
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

/**
 * 跨房路由场缓存 key。
 *
 * targetRoom + avoidHostileRooms + roomName 是首版核心维度。
 * 房间偏好和边界偏好不放进 key，而是通过 preferenceVersion 失效，
 * 避免 key 随配置细节无限膨胀。
 */
export type RoomExitRouteKey =
  `${string}:avoidHostileRooms=${boolean}:room=${string}`;

/**
 * 房间 CostMatrix 的事件戳。
 *
 * eventStamp 是 CostMatrix 缓存的版本号。每当静态或半静态通行环境变化时递增；
 * CachedCostMatrix 记录自己生成时的 stamp，落后则立即过期。
 */
export interface RoomCostMatrixStamp {
  roomName: string;
  eventStamp: number;
  updatedAt: number;
  reason?: string;
}

/**
 * 决定基础 CostMatrix 的两个维度。
 *
 * 当前版本只允许四套基础矩阵：道路是否低成本、沼泽是否高成本。
 * 战斗、拆墙等特殊 profile 暂不进入首版类型，等需求稳定后再扩展。
 */
export interface CostMatrixOptions {
  considerRoads: boolean;
  considerSwamps: boolean;
}

/**
 * heap 中缓存的一套 CostMatrix。
 *
 * CostMatrix 是 PathFinder.CostMatrix 的运行时对象，只放在 heap；
 * lastUsed 用于 LRU 类清理，eventStamp 用于通行环境变化后的精确失效。
 */
export interface CachedCostMatrix extends CostMatrixOptions {
  matrix: CostMatrix;
  roomName: string;
  eventStamp: number;
  createdAt: number;
  lastUsed: number;
}

/**
 * CostMatrix 缓存 key。
 *
 * stamp 放入 key 可以让同一房间旧版本和新版本天然隔离；
 * 清理逻辑仍应主动删除旧版本，避免 heap 占用增长。
 */
export type CostMatrixKey =
  `${string}:roads=${boolean}:swamps=${boolean}:stamp=${number}`;

/**
 * 房间内矩形区域，坐标闭区间。
 *
 * 主要用于描述复用 Flow Field 的 patch 边界。闭区间让索引换算更直接：
 * width = x2 - x1 + 1，height = y2 - y1 + 1。
 */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * 复用 Flow Field 的局部覆盖层。
 *
 * 复用建场不复制完整 2500 格方向数据，而是在 baseFieldId 指向的基础场上
 * 覆盖一个局部矩形。directions 保存 patch 内方向，trusted 标记哪些格子已经
 * 被证明能接入新目标可信区域，用于防止路径被带回旧目标。
 */
export interface ReusedFlowFieldPatch {
  baseFieldId: string;
  targetKey: string;
  range: number;
  bounds: Rect;
  directions: Uint8Array;
  trusted: Uint8Array;
  reusedDepth: number;
}

/**
 * 房间内方向场。
 *
 * Flow Field 记录“从任意格走向目标时下一步应走哪个方向”。
 * 它与生成时使用的 CostMatrix eventStamp 绑定，但主流程不每 tick 强制比较；
 * critical 的 CostMatrix 更新会在入口直接清空对应房间 Flow Field。
 *
 * data 是完整方向数组，长度通常为 2500，值 0 表示不可达，1-8 表示 Screeps 方向。
 * reused 场可以省略 data，通过 patch + reusedFrom 读取基础场方向。
 */
export interface FlowField extends CostMatrixOptions {
  id: string;
  roomName: string;
  targetKey: string;
  range: number;
  costMatrixEventStamp: number;
  createdAt: number;
  activeAt: number;
  score: number;
  retentionScore: number;
  buildType: FlowFieldBuildType;
  reusedFrom?: string;
  reusedDepth?: number;
  patch?: ReusedFlowFieldPatch;
  data?: Uint8Array;
}

/**
 * 复用候选评分所需的输入。
 *
 * 评分不直接依赖 FlowField 对象，是为了让候选索引可以先提取轻量元信息，
 * 后续也方便在测试中单独验证评分函数。
 */
export interface FlowFieldScoreInput {
  sourceScore: number;
  targetDistance: number;
  sourceAge: number;
  reusedDepth: number;
}

/**
 * Flow Field 复用策略配置。
 *
 * 复用的收益是降低 CPU 峰值，风险是方向场非全局最优。
 * 因此这里同时限制候选质量、目标距离、候选数量、复用深度和 patch 大小；
 * 任一约束失败时实现应回退完整建场。
 */
export interface FlowFieldReuseConfig {
  minReusableScore: number;
  minReuseScore: number;
  maxTargetDistance: number;
  maxReuseCandidates: number;
  bucketSize: number;
  maxReuseDepth: number;
  maxPatchCells: number;
}

/**
 * Flow Field 保留性评分配置。
 *
 * Flow Field 不采用固定 TTL。保留性由质量、年龄、活跃度、复用深度和 patch
 * 大小共同决定。这样高频使用且质量高的场可以长期保留，低价值复用场会更快清理。
 */
export interface FlowFieldRetentionConfig {
  minRetentionScore: number;
  agePenaltyPerTick: number;
  inactivePenaltyPerTick: number;
  activeBonus: number;
  reusedDepthPenalty: number;
  patchSizePenalty: number;
}

/**
 * 当前房间内的局部移动目标。
 *
 * goto 的主流程会先把全局目标拆成当前房间 segment：
 * - 同房时是最终 position + range。
 * - 跨房时是当前房间某个出口方向，nextRoom 用于边界失败统计和调试。
 */
export type RouteSegmentTarget =
  | { type: 'position'; pos: RoomPosition; range: number }
  | { type: 'exit'; direction: ExitConstant; nextRoom: string };

/**
 * 单次房内 Flow Field 建场或读取所对应的移动片段。
 */
export interface RouteSegment {
  roomName: string;
  target: RouteSegmentTarget;
}

/**
 * 可安全放入 heap 记录或 Memory 测试夹具的轻量坐标。
 *
 * PendingMove 不直接保存 RoomPosition，是为了降低记录对象和 Screeps 原型对象
 * 的耦合，也方便后续做序列化或断言。
 */
export interface PackedPos {
  roomName: string;
  x: number;
  y: number;
}

/**
 * 上一 tick 已提交的移动意图。
 *
 * creep.move 只表示提交方向，并不保证 creep 真的移动成功。下一 tick 通过
 * expected 对比真实位置，才能判断疲劳、阻塞、边界失败或其它 stuck 情况。
 */
export interface PendingMove {
  creepName: string;
  tick: number;
  from: PackedPos;
  expected: PackedPos;
  direction: DirectionConstant;
  targetKey?: string;
}

/**
 * 一个 creep 请求另一个 creep 让路的轻量协作消息。
 *
 * 首版仍采用调用时立即 creep.move 的模型，不做全局两阶段 intent 调度。
 * 因此请求不保证同 tick 解决阻塞，只为后续 tick 或后续行为调用提供协作信号。
 */
export interface AvoidanceRequest {
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

/**
 * 避让策略对请求的决策。
 *
 * accept 可以携带建议方向；不携带方向时由 goto 在安全候选方向中选择。
 * reject 表示明确不让路，defer 表示暂不处理，通常用于疲劳、任务关键动作等场景。
 */
export type AvoidanceDecision =
  | { type: 'accept'; direction?: DirectionConstant }
  | { type: 'reject'; reason?: string }
  | { type: 'defer'; reason?: string };

/**
 * 业务可注册的避让决策函数。
 *
 * resolver 只决定“是否愿意让、偏向怎么让”；安全性检查仍由 goto 提供的
 * AvoidanceContext 完成，避免每个业务模块重复实现通行判断。
 */
export type AvoidanceResolver = (
  creep: Creep,
  request: AvoidanceRequest,
  context: AvoidanceContext
) => AvoidanceDecision;

/**
 * 避让策略可见的只读上下文。
 *
 * pendingMoves 用于避免让路到其它 creep 已经预定的位置；
 * requests 让策略能看到当前 tick 的局部压力；
 * findSafeDirections 和 isReserved 把底层通行规则封装在 goto 内部。
 */
export interface AvoidanceContext {
  pendingMoves: ReadonlyMap<string, PendingMove>;
  requests: readonly AvoidanceRequest[];
  findSafeDirections(creep: Creep): DirectionConstant[];
  isReserved(pos: RoomPosition): boolean;
}

/**
 * heap 缓存数量上限。
 *
 * Screeps global heap 虽然比 Memory 便宜，但不是无限资源。
 * 这些上限用于在长期运行中约束路由场、CostMatrix、Flow Field 和避让请求规模。
 */
export interface CacheLimits {
  maxRoomExitRoutes: number;
  maxCostMatrices: number;
  maxFlowFields: number;
  maxAvoidanceRequests: number;
}

/**
 * 单 tick 新建高成本对象的预算。
 *
 * CostMatrix、Flow Field 和跨房路由都可能造成 CPU 峰值。
 * 达到预算后，主流程应优先使用已有缓存、fallback 或延迟建场，而不是硬算到底。
 */
export interface BuildBudget {
  maxCostMatricesPerTick: number;
  maxFlowFieldsPerTick: number;
  maxRoomExitRoutesPerTick: number;
}

/**
 * goto 的聚合调试信息。
 *
 * 这些计数器面向调参与观测，不参与核心决策。实现层可以在每 tick 末刷新，
 * 也可以按 global 生命周期累计后由 getDebugInfo 暴露。
 */
export interface GotoDebugInfo {
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

/**
 * goto 在当前 global 生命周期中的 heap 状态。
 *
 * 该结构集中列出所有非持久化缓存，方便 createGoto 初始化和测试注入。
 * global reset 后这些内容从空状态开始重建，只有 GotoMemory 中的用户偏好保留。
 */
export interface GotoHeapState {
  roomExitRoutes: Map<RoomExitRouteKey, CachedRoomExitRoute>;
  costMatrices: Map<CostMatrixKey, CachedCostMatrix>;
  flowFields: Map<string, FlowField>;
  pendingMoves: Map<string, PendingMove>;
  avoidanceRequests: Map<string, AvoidanceRequest>;
  roomCostMatrixStamps: Map<string, RoomCostMatrixStamp>;
  debug: GotoDebugInfo;
}

declare global {
  /**
   * goto 的持久化挂载点。
   *
   * 只保存用户配置，不保存任何运行期缓存。这样脚本重载后不会继承旧 global
   * 中的 CostMatrix、Flow Field、路由场或堵塞状态。
   */
  interface Memory {
    goto?: GotoMemory;
  }
}
