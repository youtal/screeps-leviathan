/**
 * 文件摘要：定义 goto 移动模块的目标、路径、缓存、选项、结果与公共接口协议。
 *
 * 模块位置：src/modules/goto 的类型契约。当前目录只有本文件，createGoto 与 roomRoute/、
 * costMatrix/、flowField/、movement/、avoidance/、debug/ 等实现文件按 docs/design/goto.md
 * 的目录规划逐步落地；因此本文件是调用方与实现之间的唯一稳定接口约定。
 *
 * 主要输入 / 输出：对外能力由 GotoModule 描述（goto/onTickEnd/避让策略注册/房间与边界偏好/
 * getDebugInfo）；调用方的输入形态是 GotoTarget 与 GotoOptions，输出形态是 GotoResult；
 * 内部实现则依赖 RoomEdge、CachedRoomExitRoute、CachedCostMatrix、FlowField、
 * PendingMove、AvoidanceRequest 等缓存与协作协议。
 *
 * 状态与依赖：本文件是模块设计的类型契约，集中使用判别联合、泛型和 Screeps 原生类型，
 * 让调用方在编译期区分目标形态与移动结果。类型声明会在构建后擦除，不增加
 * 游戏 tick 的 CPU 或 Memory 开销；实际寻路算法将在对应实现文件中落地。
 * 唯一进入 Memory 的数据是 GotoMemory（用户偏好），其余缓存都在 heap 中随 global 生命周期失效。
 *
 * 与设计文档的差异：docs/design/goto.md 的示例为说明方便使用 DirectionConstant 或
 * 列出 updateCostMatrix/reusedFlowField 等字段；本文件是实现的权威契约，其中房间出口相关的
 * direction 一律收窄为 ExitConstant（仅 4 个基本方向），GotoModule 与 GotoResult 只声明
 * 当前实现确实提供的成员，差异处均有单独说明。
 */
import type { PluginContext } from '@/core/framework';

/**
 * goto 可以接受的目标形态。
 *
 * 业务模块通常不应该为了移动而手动拆解目标对象；采矿、搬运、升级等行为
 * 往往天然持有 Source、Structure、Controller、Flag 或 RoomPosition。
 * 因此这里支持以下三类输入：
 * - RoomPosition：最直接的房间坐标。
 * - 带 pos 的对象：覆盖大多数 Screeps 房间对象。
 * - 轻量坐标对象：便于测试、序列化或从 Memory 中还原目标。
 *
 * 三种形态的边界：RoomPosition 与携带 pos 的对象都必须在当前 tick 内有效，
 * Game 对象及其位置引用不能跨 tick 保存；轻量坐标对象是纯数据，可以从 Memory
 * 或测试夹具里安全还原，但需要实现层按 roomName/x/y 重新构造位置。
 * 该联合不使用判别字段——三种形态靠结构化检查区分（是否有 pos、是否为坐标对象）。
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
 *
 * 状态字段 FlowField.buildType 使用该联合：它决定质量分数、保留性惩罚与清理优先级，
 * 当前实现预期只产出 full/reused，partial 仅是类型占位，不对应任何已落地流程。
 */
export type FlowFieldBuildType = 'full' | 'reused' | 'partial';

/**
 * 本次 goto 最终使用的移动决策来源。
 *
 * 这个字段用于上层调试和统计：正常情况下应优先是 flowField；
 * 当建场失败、预算不足或遇到异常地形时，会退到 PathFinder 或更轻量 fallback。
 *
 * 四种取值的判断边界：
 * - flowField：命中或新建了房内方向场，从场中读取方向；
 * - pathFinder：Flow Field 不可用，退到 PathFinder.search 得到本段目标；
 * - fallback：更轻量的兜底（例如直接朝目标方向的简单移动）；
 * - none：没有产生任何移动决策（已在范围内、目标不可达或本次被阻塞）。
 */
export type GotoPathType = 'flowField' | 'pathFinder' | 'fallback' | 'none';

/**
 * 单次移动调用的行为选项。
 *
 * 这些选项描述的是“本次移动偏好”，而不是模块级永久配置。
 * 其中 considerRoads + considerSwamps 共同决定房内 CostMatrix 的基础版本；
 * 当前设计刻意不引入 matrixProfile，避免首版过早膨胀出太多缓存维度。
 *
 * 缺省约定：全部字段可选，未传入时由 GotoConfig.defaults 提供（见下文），
 * 设计文档明确的两个默认值是 range=0、maxRooms=16；其余默认值必须以 defaults 为准，
 * 调用方不应假设某个具体数值。单位：range 为格数（0 表示同格），
 * maxRooms 为房间个数，其余为布尔开关。
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
 *
 * 字段语义：code 是本次实际提交动作的 Screeps 返回码，单个字段不足以表达上下文，
 * 因此需要结合 moved/arrived/blocked 一起判断；reason 是给日志/调试用的可选说明，
 * 不参与逻辑判断。
 * 设计文档的示例里还有 reusedFlowField 字段，当前类型用 usedCache + pathType 表达
 * “是否走了缓存/复用路径”，尚未拆出单独的复用标志。
 */
export interface GotoResult {
  /**
   * 本次移动动作的 Screeps 返回码（来自 creep.move 或 fallback 的等价提交）。
   * 它只描述底层 API 的返回值，是否到达/是否被阻塞请看下面的布尔字段。
   */
  code: ScreepsReturnCode;
  /** 是否已经成功提交 creep.move（提交成功不等于下一 tick 一定位移成功）。 */
  moved: boolean;
  /** 本 tick 调用前是否已在 range 内；为 true 时通常不会提交移动。 */
  arrived: boolean;
  /** 是否因动态阻塞（其它 creep/预定格）未能提交移动。 */
  blocked: boolean;
  /** 是否已向挡路 creep 发出避让请求；不保证同 tick 解决阻塞。 */
  requestedAvoidance: boolean;
  /** 本次决策是否使用了缓存或复用结果（路由场/CostMatrix/Flow Field 复用）。 */
  usedCache: boolean;
  /** 本次决策的来源通道，供统计与问题定位使用。 */
  pathType: GotoPathType;
  /** 可选的补充说明，例如降级原因或失败细节。 */
  reason?: string;
}

/**
 * goto 模块暴露给业务层的公共能力。
 *
 * 模块边界刻意保持在“移动基础设施”层：
 * - goto 执行单个 creep 的移动决策（Creep 与 PowerCreep 共用同一套寻路与缓存）。
 * - onTickEnd 做 tick 末维护，如 PendingMove 检查和缓存清理；它由框架的 tick 钩子调用，
 *   业务代码不需要手动触发。
 * - registerAvoidance/unregisterAvoidance 维护具名避让策略表，供阻塞协作使用。
 * - preference 接口写入 Memory，表达长期通行偏好。
 * - getDebugInfo 返回 GotoDebugInfo 的只读快照，供观测与调参。
 *
 * 与设计文档的差异：文档列出的 updateCostMatrix 尚未进入本接口（CostMatrixUpdateOptions
 * 已作为该入口的协议预留），因此当前类型不声明该成员，避免调用方依赖未实现的能力。
 */
export interface GotoModule {
  /** 驱动单个 creep 向目标移动一次；同一 tick 内可重复调用，结果见 GotoResult。 */
  goto(
    creep: Creep | PowerCreep,
    target: GotoTarget,
    options?: GotoOptions
  ): GotoResult;
  /** tick 末维护：检查上一 tick 的 PendingMove、清理过期请求与低保留性缓存。 */
  onTickEnd(): void;
  /** 注册/覆盖具名避让策略；同名重复注册按实现约定覆盖。 */
  registerAvoidance(policyName: string, resolver: AvoidanceResolver): void;
  /** 注销避让策略；未注册的名字应为无副作用的空操作。 */
  unregisterAvoidance(policyName: string): void;
  /** 写入某房间的长期通行偏好（持久化）。 */
  setRoomPreference(roomName: string, preference: RoomPreference): void;
  /** 写入某条有向边界的长期通行偏好（持久化）。 */
  setRoomBoundaryPreference(
    fromRoom: string,
    toRoom: string,
    preference: BoundaryPreference
  ): void;
  /** 读取当前聚合调试信息；返回快照而非内部可变对象。 */
  getDebugInfo(): GotoDebugInfo;
}

/**
 * goto 模块级配置。
 *
 * defaults 是 GotoOptions 的默认值集合；调用 goto 时传入的 options 会覆盖它。
 * 其它配置用于控制缓存规模、单 tick 建场预算、Flow Field 复用和保留性评分。
 * 这些值属于代码配置，不写入 Memory；global reset 后可以从工厂参数重新生成。
 *
 * 类型技巧：defaults 用 `Required<Pick<GotoOptions, ... 12 个键 ...>>` 而不是
 * `Partial<GotoOptions>`——Pick 的键清单被显式写死，Required 又要求全部提供，
 * 因此实现侧必须给出一份完整、无遗漏的默认值；GotoOptions 新增字段时不会
 * 悄悄获得隐式默认值，而是必须在配置处显式决策。其余四项用 Partial，
 * 表示只覆盖需要调整的维度（深层合并由实现负责）。
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
 * Goto 通过 Framework 的统一 persistence 接口查询或提交用户偏好；路径、CostMatrix
 * 和 Flow Field 仍只保存在 GotoHeapState，不进入任何持久化分区。
 *
 * `PluginContext<GotoMemory>` 把 Memory 的静态形状绑定到 persistence：query() 返回
 * 深只读视图，commit() 在回调前标脏并把可变对象交给调用者修改；tick、pluginId、
 * cpu 预算、事件总线等能力都由上下文提供。上下文可以跨 tick 缓存，但其中的
 * Game 对象不能跨 tick 保存，这一点对 goto 内的 creep/position 缓存同样适用。
 */
export interface GotoContext extends PluginContext<GotoMemory> {}

/**
 * goto 唯一写入 Memory 的数据。
 *
 * 这里故意只保存用户偏好，不保存 CostMatrix、Flow Field、路由场或避让请求。
 * 这些运行期缓存依赖当前 global 生命周期，持久化它们容易继承过期地形、
 * 旧敌情或旧堵塞状态，反而让移动系统变得不可解释。
 *
 * 两个字段都是可选的 Record，键分别是房间名与 `${fromRoom}->${toRoom}`：
 * 缺省（或值为 undefined）表示没有偏好，实现应按中性成本处理并允许随时删除条目；
 * 数据由 Framework 的持久化分区管理，版本迁移交给插件 manifest.version。
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
 *
 * 使用边界：设计文档中的 `goto.updateCostMatrix(roomName, options)` 入口尚未出现在
 * GotoModule 接口里，本类型目前是该入口的协议预留；实现落地时应保持
 * reason 仅供诊断、critical 决定是否连带清空 Flow Field 的语义。
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
 *
 * 单位与边界：x/y 是房间级别的整数索引（不是房内 0-49 坐标），可正可负、无固定上界；
 * roomName 保留原始房名，便于解析与反解析互相校验。该类型只用于跨房图搜索，
 * 不能与 RoomPosition 混用，也不参与 CostMatrix 计算。
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
 *
 * 字段约定：from/to 是房间名；direction 使用 ExitConstant（仅 TOP/RIGHT/BOTTOM/LEFT
 * 四个基本方向，比 DirectionConstant 更精确地表达“这是一个房间出口”）；cost 是相对权重
 * （不是 tick、也不是 CPU，用于 A* 比较与偏好倍率叠加）；passable 是硬性开关，
 * 为 false 时该边不可选。设计文档示例写作 DirectionConstant，以本类型为准。
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
 *
 * 字段约定：三个字段都可选，未设置表示该维度中性——按设计文档，cost 缺省等价于 1.0，
 * avoid 缺省为 false，passable 缺省为 true。reason 只用于日志与排错，不参与计算。
 * 该结构会持久化到 GotoMemory，因此必须保持纯数据，不能放宽为携带游戏对象。
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
 *
 * 与 RoomPreference 的差别：这里只有 passable/cost（可走程度与权重），没有 avoid——
 * 边界是二元的通道，要么走要么绕别的出口；同样持久化在 GotoMemory.boundaryPreferences。
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
 *
 * 字段含义与生命周期：
 * - roomName/targetRoom：本条记录适用的起点房间与最终目标房间，均由 key 共同决定；
 * - avoidHostileRooms：生成时所采用的避让口径，是 key 的一部分，避免不同口径互相覆盖；
 * - exitDirection/nextRoom：本房间应该走的出口方向，以及穿过该出口后进入的房间，
 *   后者用于下一段路由查询与边界失败统计；
 * - createdAt/lastUsed：均为 Game.time，前者用于年龄惩罚，后者用于 LRU 清理；
 * - preferenceVersion：生成时的偏好版本号，房间或边界偏好变化后整体失效，
 *   从而不必把偏好细节塞进 key；
 * - routeCost：本次 A* 得到的房间级相对代价，用于候选比较与调试。
 * 整个结构只存在于 heap，global reset 后重建，不写入 Memory。
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
 *
 * 类型技巧：模板字面量类型把运行时拼接格式固化到编译期，写错顺序或漏掉字段会直接报错；
 * 其中 `${boolean}` 会展开为 'true' | 'false' 两个字符串字面量，因此 key 里出现的是
 * 文本形式的布尔值（例如 `W1N1:avoidHostileRooms=true:room=W2N1`），
 * 实现层必须用同样的插值方式拼 key，不能依赖默认的布尔转字符串以外的格式。
 */
export type RoomExitRouteKey =
  `${string}:avoidHostileRooms=${boolean}:room=${string}`;

/**
 * 房间 CostMatrix 的事件戳。
 *
 * eventStamp 是 CostMatrix 缓存的版本号。每当静态或半静态通行环境变化时递增；
 * CachedCostMatrix 记录自己生成时的 stamp，落后则立即过期。
 *
 * 单位与生命周期：eventStamp 是房间内单调递增的计数器（不是 tick），只在当前 global
 * 生命周期内有效；updatedAt 记录最后一次递增的 Game.time，reason 说明触发原因。
 * 重大变化（阻挡建筑、rampart 状态、控制权变化等）会连带清空本房间 Flow Field，
 * 非重大变化只让 CostMatrix 过期，具体判定见 CostMatrixUpdateOptions。
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
 *
 * 该接口同时被 CachedCostMatrix 与 FlowField 继承，使“一个场/矩阵基于哪种成本口径生成”
 * 成为可比较的一等字段：复用与命中判定都要求这两个布尔值完全一致。
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
 *
 * 字段生命周期：matrix 是 2500 格的运行时数组，无法序列化，因此绝不能进入 Memory；
 * roomName + considerRoads/considerSwamps 共同界定它的适用范围；createdAt/lastUsed
 * 都是 Game.time，前者用于年龄统计，后者在每次命中时刷新以支撑 LRU 淘汰。
 * 当 eventStamp 小于 RoomCostMatrixStamp 的当前值时必须立即丢弃，不得继续用于建场。
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
 *
 * 与路由场 key 一样是模板字面量类型：四个维度都必须按同样格式插值，
 * 其中 `${number}` 会接受任意数字字面量，因此新增事件戳就会自然产生新键，
 * 旧键只能靠清理逻辑删除（这是“隔离”而不是“自动回收”）。
 */
export type CostMatrixKey =
  `${string}:roads=${boolean}:swamps=${boolean}:stamp=${number}`;

/**
 * 房间内矩形区域，坐标闭区间。
 *
 * 主要用于描述复用 Flow Field 的 patch 边界。闭区间让索引换算更直接：
 * width = x2 - x1 + 1，height = y2 - y1 + 1。
 *
 * 单位与边界约定：四个值都是房内 0-49 的格坐标，且必须满足 x1 <= x2、y1 <= y2；
 * 类型本身不校验顺序，由生成方保证。patch 的行优先偏移按
 * `(y - y1) * width + (x - x1)` 计算，避免为每个格子额外存坐标。
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
 *
 * 字段与内存布局：
 * - baseFieldId/reusedDepth：基础场标识与复用链深度，深度参与保留性惩罚；
 * - targetKey/range：本次 patch 对应的新目标与到达范围，与 base 场不同，
 *   因此读取时必须先看 patch 是否覆盖当前格；
 * - bounds：patch 覆盖的闭区间矩形，directions/trusted 的下标都相对该矩形；
 * - directions/trusted：两个等长 Uint8Array（长度 = width * height）。directions
 *   取值 0（不可达）或 1-8（Screeps 方向），trusted 只有 0/1；
 *   Uint8Array 每格 1 字节且不装箱，是 heap 占用的主要来源，也是 patch 尺寸上限
 *   maxPatchCells 的直接原因。
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
 *
 * 字段与生命周期：
 * - id 是 heap 内唯一标识，patch.baseFieldId 与 reusedFrom 都指向它；
 * - roomName/targetKey/range/considerRoads/considerSwamps 共同构成“精确命中”条件，
 *   CostMatrixOptions 由本接口继承，因此口径不一致的场不会被误用；
 * - costMatrixEventStamp 记录生成时的 CostMatrix 版本，供重大更新时批量清理；
 * - createdAt 是生成 tick，activeAt 在每次被读取后刷新为当前 tick；
 * - score 是建场质量分（完整建场初始为 100），retentionScore 是周期性保留性评估的结果，
 *   后者低于阈值即被清理；buildType/reusedDepth/patch 用于复用惩罚与来源追踪。
 * 所有字段都是 heap 数据：不写 Memory，global reset 后整体重建。
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
 *
 * 字段单位：sourceScore 是候选场的质量分（与 FlowField.score 同尺度），
 * targetDistance 是新旧目标的格距离，sourceAge 是候选场年龄（tick，
 * 一般用 Game.time - activeAt/createdAt 得到），reusedDepth 是候选场自身的复用深度。
 * 按设计文档，评分从 sourceScore 出发扣减距离、深度与年龄惩罚，低于
 * minReuseScore 时放弃复用。
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
 *
 * 各字段含义与单位：minReusableScore 是进入复用候选索引的最低质量分；
 * minReuseScore 是最终采纳复用结果的最低评分；maxTargetDistance 是新旧目标的
 * 最大格距离；maxReuseCandidates 是每次建场考察的候选数量上限；
 * bucketSize 是空间哈希桶的边长（格，设计文档建议 5 或 10）；
 * maxReuseDepth 是允许的最大复用链深度；maxPatchCells 是复用 patch 的格数上限。
 * 这些值来自 GotoConfig.flowFieldReuse，属于代码配置，不写入 Memory。
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
 *
 * 各字段含义：minRetentionScore 是保留阈值，低于它即进入清理候选；
 * agePenaltyPerTick 是按生成时间累计的每 tick 惩罚，inactivePenaltyPerTick 是按
 * 最近活跃时间累计的每 tick 惩罚，两者都让“老而不用”的场更快淘汰；
 * activeBonus 奖励近期被读取过的场；reusedDepthPenalty/patchSizePenalty 是
 * 复用链深度与 patch 规模的固定惩罚。评分公式见设计文档，计算发生在周期任务中，
 * 不在 goto 主流程里，因此不影响单次移动的 CPU。
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
 *
 * 这是带 `type` 判别字段的联合：实现层用 switch/if 判断 type 后即可收窄到具体分支，
 * 访问另一分支的字段会直接编译报错。两个分支的 direction 都收窄为 ExitConstant，
 * 因为房间内的出口场只可能朝四个基本方向；range 只在 position 分支存在，
 * 出口分支的到达条件是“踩到该方向的出口格”。
 */
export type RouteSegmentTarget =
  | { type: 'position'; pos: RoomPosition; range: number }
  | { type: 'exit'; direction: ExitConstant; nextRoom: string };

/**
 * 单次房内 Flow Field 建场或读取所对应的移动片段。
 *
 * roomName 是本次要处理的房间，target 是该房间内的目标。跨房移动会被拆成
 * 若干 segment 逐段执行：每个 segment 对应一次“按 CostMatrix 取/建 Flow Field →
 * 读取方向 → 提交移动”，因此它是连接跨房路由与房内方向场的中间结构。
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
 *
 * 使用边界：x/y 是房内 0-49 坐标，roomName 必填；它不是 RoomPosition，
 * 不能直接交给 Screeps API，需要时用 `new RoomPosition(x, y, roomName)` 还原。
 * 三个字段都是原始值，因此该结构可以被 JSON 序列化（例如写入测试夹具）。
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
 *
 * 字段生命周期：tick 记录提交时的 Game.time，因此实现可以区分“上一 tick 的记录”
 * 与更早的残留（后者应视为无效并清理）；from/expected 是提交前后的预期位置，
 * 用轻量坐标保存；targetKey 可选记录当次目标标识，便于把 stuck 归因到具体目标。
 * 该记录只缓存一个 tick，检查完即删除或标记，不属于长期状态。
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
 *
 * 字段与生命周期：id 用于去重与追踪，tick 记录创建时刻（请求只在当前 tick 内有效，
 * tick 末统一清理）；requesterName/blockerName 用名字而不是对象引用，避免跨 tick
 * 持有失效的 creep；from 是请求方当前位置，blockedPos 是被占住的目标格，
 * desiredDirection 是它想走的方向；priority 是让路优先级（数值尺度由实现与策略约定，
 * 用于比较多个请求的紧迫程度）；reason 仅供日志。from/blockedPos 是 RoomPosition，
 * 属于 Game 运行时对象，只有在“请求不跨 tick 存活”的前提下才安全；
 * 该结构只存在于 heap，不写入 Memory，global reset 后清空。
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
 *
 * 同样是判别联合：三种取值分别对应“让路（可指定方向）”“拒绝（可附原因）”
 * “暂缓（可附原因）”。reject 与 defer 的区别在于语义——reject 表示策略明确反对，
 * defer 表示当前不宜处理但之后可以再问；实现可以据此选择是否在后续 tick 重试。
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
 *
 * 调用约定：在阻塞发生的同一 tick、同一调用栈内同步执行，因此实现必须保持轻量
 * （不要做寻路或全房间扫描）；返回 accept 时给出的方向仍会经过 goto 的安全过滤，
 * 策略不必自行确认该格是否可走。creep 参数是当前帧的 Game 对象，
 * 不能被策略闭包长期保存。
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
 *
 * 只读性说明：ReadonlyMap/readonly 数组只是类型层面的保护，底层容器仍由 goto 持有，
 * 策略不应也不能通过它们修改模块状态；两个函数是即取即用的查询，
 * 返回的方向数组是新建的普通数组，调用方可以安全地继续过滤。
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
 *
 * 单位均为条目数（不是字节），到达上限后按设计文档的清理顺序淘汰：
 * 先清低保留性 Flow Field 与过期 CostMatrix，再清最久未使用的路由场；
 * 避让请求同时受 tick 末清理约束。上限来自 GotoConfig.cacheLimits。
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
 *
 * 三个字段都是“每 tick 允许新建的数量”，计数器随 tick 重置（属于 heap 状态，
 * 不持久化）。预算耗尽属于正常降级路径而非错误：实现应回退到缓存、PathFinder
 * fallback 或拒答，让同一 tick 内的其它 creep 仍有机会使用已建好的场。
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
 *
 * 字段口径：*Built 是新建数量，flowFieldsReused 是复用建场次数，
 * flowFieldsInvalidatedByCostMatrixUpdate/flowFieldsEvictedByRetention 是两条清理路径的
 * 计数，cacheHits/cacheMisses 反映缓存命中率，stuckEvents 是移动未达预期的次数，
 * avoidanceRequests 是发出的避让请求数；cpuUsed 单位与 Game.cpu.getUsed() 一致（毫秒）。
 * 统计窗口由实现决定（每 tick 重置或按 global 累计），使用方不应假定固定口径。
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
 *
 * 各容器的键：roomExitRoutes 用 RoomExitRouteKey，costMatrices 用 CostMatrixKey，
 * flowFields 用 FlowField.id，pendingMoves 用 creep 名（每个 creep 每 tick 至多一条），
 * avoidanceRequests 用 AvoidanceRequest.id，roomCostMatrixStamps 按房间名保存版本号；
 * debug 是内嵌的计数器对象。整个结构不可序列化，禁止写入 Memory 或 RawMemory。
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
