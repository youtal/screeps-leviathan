# goto：原生寻路、方向缓存与移动协作设计

交付状态：设计已形成；运行时实现、公共类型、使用说明及测试均未交付。目标模块路径为 `src/modules/goto/`。下文接口是设计协议，不是已发布 API。

## 1. 模块职责与存储边界

goto 负责移动规划、CostMatrix 复用、方向缓存、己方 creep 阻塞检测和避让协作。房间路线使用 `Game.map.findRoute`，格子路径使用 `PathFinder.search`，不实现寻路算法。方向缓存只记录原生搜索已探明的路径，不计算完整流场。

**只有房间有向权重纳入 MemoryManager 持久化管理。** 包括该权重表的 schema 和修订号；不包含其他业务状态。terrain、热点厌恶区域配置、CostMatrix、pathCache、路由缓存、工作状态、策略表、移动记录、请求和预约全部由工厂闭包 heap 持有。global reset 后重建，热点规则和策略由应用配置重新注入。禁止直接访问 Memory、RawMemory 或 creep.memory。

首期支持普通 Creep、同 shard 常规房间出口和同房相邻空位避让。PowerCreep 的主动移动、portal、pull、跨 shard 和多人推挤链不在本协议内；PowerCreep 的占位仍须作为动态障碍观察。

正确性以已观察的环境事实为边界。无视野房间只能提供估计；搜索未完成不等于不可达；API 返回 OK 不等于实际移动成功。对房间偏好、格子成本、工作约束分别作出保证，不承诺联合全局最优。

## 2. 对外接口与实例生命周期

### 2.1 工厂与返回对象

拟定入口为 `createGoto(options: GotoOptions): GotoModule`。每个实例拥有独立闭包，不依赖模块级隐含单例。同一 creep 不能同时交给多个实例；应用装配时必须划定实例控制范围。

`GotoOptions` 包含：

| 配置组 | 内容 |
| --- | --- |
| identity | pluginId、serviceName；全框架唯一 |
| profiles | 带稳定 ID/version 的地形、road 成本和热点厌恶规则；未知房间处理模式 |
| policies | 按 owner、role、state 登记的应答与方向策略 |
| cache | 房间数、goal 数、矩阵/方向数组及依赖索引字节上限 |
| search | maxOps、每 tick 搜索次数、分段重试次数和 CPU 准入阈值 |
| traffic | 请求容量、协议超时、重复请求冷却和优先级规则 |

工厂只校验配置并创建闭包，不能在 import 或工厂调用时申请 Memory、订阅事件或读取 Game。框架 setup 负责服务发布、申请权重分区和登记清理；tick 钩子负责环境观察、规划和收尾。显式注入可测试的平台适配端口，生产端口由应用装配提供。

返回对象包含以下能力；同一服务对象也通过 `plugin` 的 setup 发布，直接持有工厂返回值不绕过生命周期和 owner 校验。

| 成员 | 参数与返回 | 约束 |
| --- | --- | --- |
| `plugin` | 可注册的 `LeviathanPlugin` | 消费者 manifest.requires 包含其 pluginId |
| `goto(context, creep, target, work, options?)` | 收集一次移动要求，返回 tick 内有效的 RequestHandle | 仅 owner 的 onTickBegin；target 含位置及 range，options 指定 profile |
| `hold(context, creep, work)` | 登记原地工作及避让能力，返回 RequestHandle | 与 goto 共用每 creep 每 tick 一次登记额度 |
| `flush(context)` | 将该 owner 的最终计划提交为意图，返回动作关联列表 | 仅 owner 的 onTickExecute；每 owner 每 tick 最多一次；无计划不提交 |
| `getResult(handle)` | 返回排队、规划、应答或提交结果的只读快照 | tick/generation 过期返回 expired，不暴露可变计划 |
| `cancel(context, creepId, generation)` | 撤销本人本轮计划和配对；幂等 | commit 前有效；已调用原生 move 后不能承诺撤回 |
| `release(context, creepId)` | 解除本人长期 owner 绑定，并取消相关请求 | 不清除公共方向缓存 |
| `weights` | 有向权重的 get/list/set/delete/update/reset，详见 §4 | 持久化唯一入口；未就绪返回 pending |
| `configureProfile(profile)` | 创建或显式替换 profile；替换必须递增 version | setup 或 tick 边界生效，清除依赖该版本的 heap 缓存 |
| `setRoomAreas(room, profileId, areas)` | 替换该房间/profile 的厌恶区域，返回区域 revision | 仅 heap；修改在下一 tick 边界生效，不使用时间过期 |
| `registerPolicies(context, definitions)` | 登记 owner 的策略，返回 dispose 句柄 | owner setup；替换版本须递增，停用清理 |
| `invalidateRoom(room, reason, changedPositions?)` | 标记结构待核验；位置集合是更新提示 | 不能通过通知直接声明环境已经核验 |
| `inspect(query)` | 有界返回配置版本、缓存及交通指标副本 | 不返回内部矩阵或数组引用 |

`WorkState` 至少包含 role、state、generation、interruptible、工作锚点/允许范围；可选 policyKey 和轻量业务数据。目标、工作限制或关键状态改变时增加 generation。所有 profile、位置、range、owner 和调用阶段在收集时验证；错误返回 invalid/phaseError/ownerConflict，不消费有效登记额度。

### 2.2 tick 阶段与动作归属

每个 creep 每 tick 只有一个 owner、一次有效 goto/hold 登记和至多一次原生 move 调用。内部可以调整最终方向，但不得以第二次 move 覆盖第一次 move。Framework 意图提交本身不等于调用游戏动作；不走路的 hold 不调用 move。

CPU 收益分两部分：不产生不必要的 move 意图可减少固定意图费用；只做一次移动决策可减少脚本计算和方向覆盖。官方驱动的 intents.set 对同对象、同动作的覆盖不重复计入 0.2，因此不能把“少调用一次同 tick move”一律折算为节省 0.2；真实收益应按最终意图及脚本 CPU 测量。[官方驱动实现](https://github.com/screeps/driver/blob/master/lib/runtime/runtime.js)

采用如下时序：

1. **goto.onTickBegin**：建立本轮收集表，验证双表 tick 连续性，准备权重快照。
2. **所有消费者 onTickBegin**：提交 goto/hold 和本 tick 工作快照。不在此时提交 GameIntent，也不要求被阻塞者先于请求者登记。
3. **goto.onTickExecute**：此时所有 begin 均已结束。集中核验、查方向缓存、搜索、产生避让请求、调用响应者策略、预留目的格，并发布本 tick 最终计划。新请求当 tick 得到应答。
4. **消费者 onTickExecute**：按最终计划调用 flush(context)，以本人的上下文提交 move 意图。业务若改变工作状态，先 cancel，再决定其他行为。
5. **Framework commit**：检查计划未撤销、身份/工作/政策版本仍有效后，至多调用一次 creep.move。匹配回执及实际位置用于后续核验。
6. **goto.onTickEnd**：轮换移动双表、释放本 tick 临时矩阵和预约，执行有界回收，不提交移动动作。

此顺序利用 Framework 的“全部 begin → 全部 execute → commit → end”协议和消费者对 goto 的依赖顺序。onTickEnd 属于收尾，不能提交动作；集中规划应放在 goto.onTickExecute。消费者必须在 begin 完成移动所需工作决策，在 execute 调用 flush；未调用 flush 的 owner 不会获得自动代执行。goto 没有通过自己的上下文冒用消费者动作的权限。

begin 抛错或 owner 被跳过时，其收集记录可能仍存在，但不会绕过 Framework 资格检查执行。配对计划要求双方都在本轮登记并提交；框架随后拒绝某个 owner、CPU 耗尽或引擎冲突仍可能导致单边失败，按 §8 恢复。消费者暂停/停用时停止参与应答。

目标格预约覆盖本实例全部普通移动和避让移动，同时使用统一的 GameIntent 目标格锁。跨实例要使用同一锁命名约定；其他业务不得再直接调用受管 creep 的移动 API。

## 3. 四类成本与两种长期矩阵

### 3.1 数据组成

| 层 | 数据 | 保存方式 |
| --- | --- | --- |
| a 地形 | 原生 terrain 查询对象；profile 的 plainCost/swampCost | terrain 可跨 profile 共用；成本参数按 profile 固定，global 内无时间有效期 |
| b 厌恶区域 | source、mineral、controller 等热点附近的额外代价及用户禁区 | 按 room/profile 固定；与 a 构成只读 AB 基底，无时间有效期 |
| c 房间结构 | road、rampart、其他建造结构及影响通行的施工状态 | 不建立独立 C 矩阵缓存；采集后叠加到 AB clone，缓存结果 ABC |
| d creep | 当 tick 单位占位，按 ignore/blockOwned/blockAll 等选项配置 | 需要时 clone ABC 后叠加；临时矩阵及其搜索结果不加入共享缓存 |

长期矩阵只有 AB 基底和 ABC 一般使用矩阵；a 的默认地形成本可保留为搜索参数，AB 无调整格用 0，不强制物化平原/沼泽成本。b 的软厌恶采用非负附加值；profile 对道路成本的覆盖不能意外抹掉这些附加值。

合成顺序为：先判定不可通行；可通行格以 profile 的 roadCost（存在可走道路时）或地形成本作为基本值，再加 b 的软厌恶，饱和到 254。硬禁区、阻挡结构使用 255。更新 road 格时须重新取 b 的区域规则/紧凑附加数据，不能把 AB 中已合成的地形代价再加一次。为减小 heap，不要求额外常驻一张 B 成本矩阵。

road 使用 profile 的明确 cost。**所有非己方 rampart 都视为不可通行，包括 public rampart**；这是一项防止通行权限突然收回的保守政策，不是对游戏可通行规则的描述。代价是放弃他人的公共通道。己方 rampart 也不能使同格阻挡建筑变得可通行；同格多对象按最强硬限制合成。源、矿和控制器的本体通行规则与附近的软厌恶分开。特殊地形/道路组合交由引擎适配规则判定，不能仅凭 terrain 标记覆盖合法道路。

施工点按类型、所有权及引擎通行规则处理，不能一律当墙或一律忽略。d 只修改副本；可移除自身占位，但不能清除 a/b/c 的硬禁止。共享方向搜索忽略瞬时 creep；即时绕行才启用 d，结果最多保存本 tick 方案所需的下一步。

### 3.2 结构更新、局部修补与版本

每个 ABC 保存 `matrixVersion`、`updatedAt` 和 `observedAt`。`matrixVersion` 使用实例 generation 加单调序号，`updatedAt` 是最近内容更新 tick；仅用 Game.time 不足以区分同 tick 多次更新。版本比较使用完整标识相等，不以时间大小代替身份校验。

首次需要可见房间时，每 tick 至多采集一次结构通行描述；房间级采集可供多个 profile 合成使用。本 tick 临时对象索引在结束后释放，不建立长期的第三层矩阵。允许保留用于变化检测的紧凑结构描述或精确摘要，其开销计入元数据预算。摘要碰撞不能成为漏掉更新的理由。

变化范围完整且较小时，逐格从 AB 恢复基础值，再读取该格所有结构重新合成 ABC，覆盖建筑拆除、道路消失和同格 rampart 等情况。不能只把新增障碍写为 255 而不处理删除。变化范围不明、首次可见、重新取得视野或更新格过多时从 AB clone 完整重建。实际通行成本改变即增加 matrixVersion；只观察而未改变时只更新 observedAt，不让缓存每 tick 失效。

对外部事件采用“标脏提示 + 可见事实核验”。已标脏但预算不足以核验时禁止把矩阵作为有效命中。所有局部更新在发布前完成；单次搜索使用固定版本，不能读到半更新矩阵。修改 b 或 profile 属于显式配置替换，要重建 AB/ABC 并换版本。

### 3.3 无视野与 heap 回收

AB 不设 TTL，但允许按内存上限淘汰；“无有效期”不等于永不回收。首次观察热点信息前不能把缺省空区域永久标记为已知；已知热点坐标和 profile 可一直复用，显式区域配置更新才换版本。

无视野时 ABC 是 lastSeen 快照。strict 模式拒绝未知结构房间；explore 模式可使用快照或 terrain/已知热点估计，标记 unverified。重新可见后先刷新，不能因时间戳未变化就宣称结构未变化。ABC 的 observedAt 供风险判断，不替代 matrixVersion。

矩阵、方向表、路由、依赖索引分别设数量/字节上限。LRU 淘汰后重建使用新 generation/版本，旧路径不能误命中。global reset 清空全部 heap，只有房间有向权重从 MemoryManager 恢复。

## 4. 有向房间权重

持久化表只有相邻有向边：`(shard, fromRoom, toRoom) → { cost } | { blocked: true }`。A→B 与 B→A 完全独立；缺省 cost=1。cost 为有限 `[1,1000]` 数值，NaN、Infinity、0、负数均拒绝；封禁在原生回调边界转换为 Infinity。

不额外持久化房间进入权重、热点区域、profile 或路径。希望降低/提高某房间进入偏好时，调用方对该房间各相邻入边作一次批量更新；反向出边保持不变。硬环境禁行高于自定义成本，封禁边不能因目标位于其后而被绕过。单位身处某房间时是否能撤离，由出边单独决定。

| weights 接口 | 契约 |
| --- | --- |
| `get(from, to)` | 返回显式配置、有效默认值和 revision；缺项明确标记 inherited |
| `list({from?, to?, cursor?, limit})` | 有界返回配置副本；游标绑定 revision，变化后要求重新分页 |
| `set(from, to, rule, expectedRevision?)` | 新增或替换一条有向规则；是 update 的单项形式 |
| `delete(from, to, expectedRevision?)` | 删除后恢复默认成本；不存在则 unchanged |
| `update(changes, expectedRevision?)` | 原子批量 set/delete；先全量验证，再提交 |
| `reset(expectedRevision)` | 显式清空用户边规则，环境硬限制仍生效 |

结果为 applied/unchanged/pending/conflict/invalid/capacityExceeded，附 revision 及失败原因。校验房间名、相邻关系、批次/存储容量和版本；任一项失败整批不变。同值更新不增加 revision。读写仅在实例 active 且本 tick 存储 ready 时允许；未装配返回 notReady，pending 不排队隐式写入。

setup 使用 `context.memory('roomWeights', { version: 1, layer: 'critical', … })` 申请分区。每 tick 重新 access，通过本 tick ready 视图 query/commit，禁止保存跨 tick 数据引用。先验证新快照，再 commit，成功后同步发布 heap 副本及 routingRevision。applied 表示已交给管理器，不声称底层已耐久写入。

单次规划固定权重快照。任何生效更新都使所有跨房路由和方向缓存延迟失效：未被旧路径使用的边变便宜也可能改变房间选择。已排队的跨房计划在执行前重新比对版本，变化即取消。

pending 或数据损坏时，暂停跨房规划/动作和权重写入；房内移动、观察和同房避让继续。global reset 后确认权重加载成功再允许过房，不能暂时套用默认值放行。只在首次初始化空分区时创建空规则表；无效数据保留诊断，不自动清空覆盖。配置容量按条数和序列化字节双重限制。

## 5. 原生寻路接口与跨房规划

### 5.1 接口选择

| 维度 | PathFinder.search | Room.findPath |
| --- | --- | --- |
| 接入形态 | 直接接收起点、目标和 roomCallback，适合完全控制矩阵 | Room 实例方法，提供内置房间成本及 costCallback 等便捷选项 |
| 返回信息 | 位置序列及完成度、搜索统计 | 方向步骤数组或序列化结果，调用方便但缺少同等完成度信息 |
| 模块适配 | 可直接使用 ABC 或临时 d 副本，统一房内/跨房和未完成处理 | 需要协调内置规则与自有矩阵，额外确认终点及转换结果 |
| 适用场景 | 本模块全部正式格子搜索、受预算限制的绕行 | 独立脚本的简单房内移动、调试与基准对照 |

**正式实现只使用 PathFinder.search。** 不按房内/跨房切换两个 API，避免两套规则及缓存语义。Room.findPath 是便捷封装，不能未经测量就认为它更快；直接 search 也不是无条件更快，优势是输入和结果契约更适合本模块。接口差异以 [PathFinder API](https://docs.screeps.com/api/#PathFinder.search) 和 [Room.findPath API](https://docs.screeps.com/api/#Room.findPath) 为依据。

### 5.2 房间路线与方向校验

Game.map.findRoute 的回调读取 from→to 权重，得到房间序列；PathFinder.search 负责格子搜索。不把房间成本重复加到每个格子上。只给 roomCallback 一组房间白名单不足以约束行走方向，因此按所选房间序列逐跳生成：

1. 单房目标只开放当前房间。跨房每跳只开放当前和下一个相邻房间，目标为下一个房间的合法入口集合，range=0；最终房间再搜索业务目标。
2. 校验每段只有预期方向的一次跨越，无折返或额外房间；验证出口/入口坐标及方向。入口选择失败可在限定预算内换入口重试，不能把一次失败当作整条边不可达。
3. 合并原生结果时检查位置连续、无重复位置、满足有向政策，形成临时完整路径。边界方向通过引擎适配规则计算，禁止用两房的局部 dx/dy 直接推断。
4. 完整结果编码进 §6 的方向缓存；未完成结果不写共享方向表，仅可支持本 tick 的已核验下一步或作为 heap 中有界的待续搜索任务。后续 tick 必须重新验证依赖后续算。

预算不足返回 deferred/searchLimited；空路径先判断目标 range 是否已满足，再决定 arrived 或 unresolved。多目标入口逐段选择不保证整体格子最短，跨房偏好与格子距离不作联合最优承诺。长路线分段限额规划，不突破原生搜索上限，不以自写算法回退。

## 6. 以目标为键的压缩方向缓存

### 6.1 结构与编码

采用无起点索引的目标方向表，逻辑结构为：

```text
pathCache[goalKey] = {
  rooms: { [roomName]: Uint8Array(1250) },
  matrixDeps: { [roomName]: matrixVersion },
  routingRevision, generation, lastUsedAt, knownRoomState
}
```

`goalKey` 包含 shard、目标 room/x/y、range、profile ID/version、区域配置作用域版本、未知房间模式及影响通行的稳定搜索约束。标量搜索预算不定义一套新的通行图；只缓存已完整验证的结果。目标多集合若后续支持，须先规范化排序。键允许结构化 Map；若使用散列，命中后仍比较完整语义键。

每格用 4 bit：0 表示未探明方向，1–8 表示游戏方向，9–15 保留且读到时视为损坏。每个字节存两个格子的方向，2500 格需 1250 字节。位置序号 `i=x+50*y`，字节索引 `i>>1`，低/高半字节由 `i&1` 决定；写入必须保留另半字节。

先检查当前位置是否处于目标 range，再查询方向；到达点通常也是 0，不能误当作需要重新搜索。无目标条目、依赖过期或当前位置为 0 时启动原生寻路；非 0 时按当前坐标取下一步，无需保存起点和 creep 路径游标。方向数组尺寸不含 Map、依赖、对象及分配器开销，预算不能仅计算 1250 字节。

方向表只承诺路径几何到达目标；knownRoomState 单独记录沿途是否含探索估计。探索使用的临时 ABC 也必须有带 unverified 标记的版本，首次取得结构事实后换版，不能把“原生搜索完整”解释为“全部房间已观察”。

每个房间地图保存的是“原生搜索已发现的部分方向”，不是全房间可达性表；0 也不表示不可达。避让后移动到表内任意位置可自然继续，同一目标多 creep 可共享。

方向表适用于固定图条件。需要主体例外、任意回调或未纳入 goalKey 的任务约束时，禁止复用该公共表，使用不入库的本次原生搜索结果。

### 6.2 合并必须保持无环

不能把新搜索路径沿途的所有方向直接覆盖旧方向：两条不同的正确路径也可能拼出循环。采用只增补未知前缀的规则：

1. 新路径需完整到达目标 range、无重复位置，且依赖有效。
2. 从起点前进，遇到第一个已有有效方向的位置即停止增补；保留该点及以后原有方向，复用已经连通目标的后缀。
3. 若没有已有方向，写入整条路径但不写目标终点的出方向。所有新增节点都指向原生路径上的后继，最后连到目标或已验证的旧图，因此不会引入环。
4. 写入前遍历拟连接后缀，核验连续性、边界、有向政策及终点，并拒绝导致房间序列折返等违反路由约束的拼接。该遍历只是验证已知路径，不搜索邻居。检查或内存预算不足时放弃入库，不留下半成品。
5. 同一 goal 条目内不局部改写已有非 0 方向；需要换路时作废该条目，再以新结果建立。方向表更新在本次规划内完成后发布，禁止读到半写入状态。

此规则牺牲部分“更新成更短路径”的机会，换取没有逐格成本/父节点的结构。共享后缀可能不同于从该起点重新搜索的最优结果，但必须满足相同政策和通行约束。不得把缓存描述成全局最短路径保证。

### 6.3 跨房方向与依赖

房间间的方向仍存放在出发格，下一房间由标准出口邻接关系确定。每个跨房步骤都必须由适配器验证，包括同 tick 边界传送导致的可观测坐标变化；不需要给每个 creep 保存 RoomLeg 游标。适配器若不能无歧义编码某类过房情形，则拒绝该路径入库，以临时原生步骤处理，不能猜测。

`matrixDeps` 保存该 goal 已写入路径所依赖的全部 ABC 版本，包括连接后缀和搜索采用的其他房间矩阵。任一依赖落后、缺失或未核验，就丢弃整个 goal 条目。这样不会留下“前房方向有效、后房路径已断”的残余指针，也无需逐格维护跨房依赖。

不独立淘汰条目中的某一房间方向表。淘汰粒度为整个 goal；容量不足时可以放弃入库并执行临时搜索结果。反向索引 `room → goal 集合` 仅用于快速标脏，使用前的版本校验仍是最终依据。读取可在本 tick 对同一 goal 复用已核验结果，但相关房间发生更新时要同步撤销该核验标记。

结构改变导致相关 goal 全部失效，精度是“不会继续使用落后版本”，并不表示每条受影响路径都真的必须重算。该保守范围避免引入复杂的逐格依赖图。

## 7. 缓存失效与预算

| 变化 | 行为 |
| --- | --- |
| ABC 内容变化 | 增 matrixVersion；关联 goal 整体作废 |
| 仅采样时间推进 | 只更新 observedAt；不废弃未变化矩阵的路径 |
| 任意有向权重变化 | 增 routingRevision；跨房 goal/路由作废，包括非沿途边变便宜 |
| profile 或区域规则替换 | 更换语义版本；相关 AB/ABC/goal 作废 |
| creep 占位变化 | 只影响本 tick 检查与 d 层，不废弃长期静态方向表 |
| 目标/range 变化 | 使用新的 goalKey，取消旧请求和配对 |
| 无视野/重新可见 | 保留不确定性标记；可见后刷新依赖再命中 |
| 元数据缺失/淘汰/reset | cache miss；新 generation 防止旧句柄复活 |

执行前复核下一步硬通行条件、权重/profile/工作版本、疲劳/MOVE 和预约。当前占位可以是已确认配对的响应者，具体条件见 §8；其他占位不被当作空格。无法核验时等待，不假报有效。

AB 不设有效期，ABC 以内容版本而非固定周期失效；LRU 是空间回收规则。未知房间可额外限制信息年龄，但年龄不证明环境未变。不可达负缓存只绑定明确原因及依赖，预算不足不能长期记录为无路。

至少设置 maxRooms、maxGoals、maxMatrixBytes、maxDirectionBytes、maxDependencyEntries、maxRequests、maxPendingSearches、maxSearchesPerTick、maxOpsPerSearch、maxMergeSteps 和 maxGcItemsPerTick。依赖验证为经过房间数的量级，合并验证为路径长度量级；都必须受预算控制，不能把一次字节查询的 O(1) 当作整个缓存操作的成本。

## 8. 双表阻塞检测与两 tick 避让

### 8.1 移动尝试双表

闭包维护 `attemptsCurrent` 与 `attemptsPrevious`。只有真正执行到原生 creep.move 且返回 OK 时，才向 current 写入记录：

```text
creepName → { creepId, ownerId, tick, from, expectedNext, goalGeneration, intentId }
```

其中 from 是调用 move 时的位置，不能在本 tick 把它称为“成功移动后的位置”。到下一 tick 才能观察移动结果。保留 creepId 防止死亡后同名新 creep 继承旧记录；保留 expectedNext 用来确认前方究竟是什么阻挡。

goto.onTickEnd 丢弃 previous 引用，令 previous=current，再创建空 current。不存在逐项搬运和历史全量扫描。若 tickEnd 因硬中断未完成、框架没运行或记录 tick 不是 `Game.time-1`，下一 begin 清空陈旧记录，不冒充上一 tick 尝试。global reset 两表都为空。

下一轮只对登记参与移动/hold 的 creep 检查 previous：

- 位置等于 expectedNext：移动成功，清理阻塞等待。
- 位置等于 from：上轮已接受移动但没有位移；若 expectedNext 被己方 creep 占据，产生己方阻塞请求。
- 位置不同于以上两者：外部移动/偏离，按当前坐标重新取方向，不归因于堵塞。

fatigue、无 MOVE、spawning、未 flush、框架拒绝/推迟以及原生错误都不会写 current，因此不会误列为“上 tick 主动移动但没走成”。两表本身证明的是尝试与无位移，不能独自证明是己方堵路，还需检查期望格。提交前已看到己方占位也可直接创建 potentialBlock 请求，省去一次明知有占位的 move；与 confirmedBlock 分开统计。

### 8.2 同 tick 请求和应答

所有消费者 begin 已登记本职状态后，goto 集中规划，因此即使响应者业务插件先于请求者运行，也能用其本 tick 快照即时响应。请求含双方 creepId/owner、位置、期望释放格、目标/工作 generation、创建 tick、优先级和期限；不保存跨 tick 游戏对象。

默认使用以下两个决策 tick：

| 时刻 | 请求者 A | 响应者 B | 协调状态 |
| --- | --- | --- | --- |
| t 检测/协商 | 检测到 B 阻挡，创建请求，本轮不向 B 原格盲走 | 策略当 tick 应答，并选择拟让出的安全方向 | accept 后形成执行 tick=t+1 的配对计划 |
| t+1 同步尝试 | 刷新目标/工作快照；有效时向 B 原格提交 move | 刷新工作快照；有效时向约定空位提交 move | 重验双方位置、工作、疲劳、矩阵和预约；本轮一起提交 |
| t+2 事实观察 | 检查是否进入目标格 | 检查是否离开原格 | 确认完成，或按失败事实重新协商 |

协商阶段若 B 的本职计划本来就要离开阻塞格，则优先保留其本职移动，A 等下一轮检查空位，不额外要求 B 停下来配对。需要专门让路时，accept 将双方本轮移动计划设为等待；工作策略必须允许这一等待。

t+2 是引擎结果的观察时间，不要求先观察 B 在 t+2 让开后才允许 A 提交。两个 move 在 t+1 的世界结算中尝试完成；accept 只表示策略同意及计划成立，不是已经移动成功。

配对的 t+1 计划只有在双方再次登记、位置未偏离、目标/工作 generation 相容、响应者重新确认可让路时有效。任一条件改变则取消，不能凭 t 的承诺覆盖本职新状态。t 的候选格不是跨 tick 硬预约，到 t+1 要重新竞争；冲突则等待或重选并重新确认。

### 8.3 提交、单边失败与恢复

为每对参与者生成单独的 owner 意图，各自的 subject/channel 锁及目的格锁互不混淆。双方必须完成 flush；commit 回调检查双方已提交、配对未取消和版本相容，否则不调用 move。工作业务可以 cancel 拒绝旧安排。

Framework 并不提供跨 owner 原子动作组；游戏引擎也不能保证“B 接受就一定腾空”。即使双方已提交，B 的 owner 后续失败、CPU 在 commit 中途耗尽、第三方占位或引擎冲突都可能产生单边执行。协议不伪造原子性，不在调用过 move 后补发相反方向。下一轮以实际位置为准：B 独自让开则 A 正常继续，A 未前进则重新核验，双方未动则退避或改道。

accept 的方向只允许本 tick 可确认的同房相邻空位；首期不交换位置，不把未确认将离开的第三个 creep 当空格。敌方/PowerCreep 占位不参与本应答协议。窄道无候选可拒绝，必要时由请求者执行原生绕行；不保证所有交通拓扑都可解。

同一双方身份、目标 generation 和释放格去重。响应者每轮最多采纳一个请求，请求按基础优先级、封顶等待加分、创建时间、稳定 ID 排序；响应者的工作硬限制不可被加分突破。重复拒绝冷却、让路后短期不抢回原格、持续无进展后的绕行限制互相振荡。容量不足返回 busy，不无界排队。

## 9. 注入式工作策略

策略表按 `(owner, role, state)` 直接查找，顺序为显式 policyKey → 精确角色状态 → 角色默认 → owner 默认 → 模块保守默认。显式 key 不存在返回错误，不静默挑选其他职业策略；查找最多固定层数，不扫描谓词、不读取持久化工作状态。

两个独立注入点：

| 策略 | 输入 | 输出 |
| --- | --- | --- |
| `respond(context, request)` | 本 tick WorkState、局部环境、请求和等待年龄 | accept/reject/defer、reason、附加工作约束 |
| `chooseDirection(context, candidates)` | 通过硬安全和工作约束过滤的最多 8 个候选 | 候选 ID 或 none |

先判断愿不愿意，再生成安全候选，最后决定方向。策略不能放宽非己方 rampart 禁行、硬禁区、占位和本职允许范围。方向返回 none 表示本次无法让路。集中规划在 goto 的调用栈中执行策略，但不授权其代调用业务上下文提交动作。

工作状态未刷新则不应答；策略引用缓存绑定 owner/role/state/policyVersion，工作约束另绑定 generation。t+1 执行前重新运行必要的应答/方向验证，不能跨 tick 直接复用 t 的任意回调结果。

策略同步、只读、局部且无副作用；禁止自行 move、提交意图、持久化写入、全房扫描或另启搜索。异常、Promise、非法候选都保守拒绝并限频记录。前后测量策略 CPU，超限后降级；同步回调无法强制中途抢占，不能声称任意用户函数都有硬执行上限。

| 工作状态 | 应答与方向原则 |
| --- | --- |
| 固定矿位采集 | 无替代工作格则拒绝；能让路时仍保持采集范围 |
| 运输途中 | 可中断时让路；降低远离目标、沼泽和回归代价 |
| 升级/维修 | 保持本职 range，避开补给入口 |
| 紧急撤退 | 不进入更危险区域，不因请求优先级牺牲硬安全条件 |
| 闲置 | 优先离开通道，但仍服从显式允许范围 |

默认策略只接受明确可中断且工作约束齐全的情况；其余拒绝。profile 管空间成本，工作策略管任务是否允许被打断，两者分别版本化。

## 10. 返回结果与诊断

RequestHandle 初始结果为 queued 或参数错误，规划后为 arrived/planned/waiting/blocked/deferred/policyPending/policyDenied/routeUnresolved，flush 后追加 submitted、intentId。最终移动事实通过下一 tick 双表核验记录；submitted 和 accepted 均不能替代 moved。句柄只保留有限轮次，expired 明确返回，不长期保存每次请求历史。

inspect 输出分层矩阵命中、内容更新/仅观察次数、方向命中/0 格 miss、因矩阵或政策失效的 goal 数、数组与元数据字节、原生搜索及合并验证 CPU、完整/未完成搜索数、confirmed/potential 阻塞、应答与实际让路比例、等待时长及单边失败数。日志限频，不在每 tick 序列化矩阵和整个 pathCache。

阶段权限错误、存储 pending、预算不足、策略失败与无路有独立 reason。停用释放 heap/订阅与策略注册，权重分区按 MemoryManager 生命周期保留，不因普通停用清空用户规则。

## 11. 验证与交付安排

以下均未交付，本阶段只形成设计。

| 阶段 | 验收重点 |
| --- | --- |
| 工厂、存储与生命周期 | 工厂无副作用；有向权重 CRUD/原子批次；pending/reset；实例隔离；begin 收集/execute 规划/owner flush/end 轮换 |
| AB/ABC 与 d | road profile；公共非己方 rampart 禁行；结构拆除局部恢复；同 tick 双版本；未变化观察不失效；区域替换；无视野 |
| 方向表 | 奇偶 nibble 不互相破坏；1–8 编解码；到达点为 0；无起点共享；不同搜索交叉不成环；跨房边界；依赖过期整 goal 丢弃 |
| 双表与协作 | API OK 但未移动；fatigue 不入表；名字复用；tickEnd 中断；消费者顺序调换；t 应答/t+1 同时提交；工作改变撤销；第三方抢位与单边失败 |
| 性能与恢复 | 多单位同目标/随机目标；频繁结构和权重更新；集中失效；低 CPU；global reset；字节上限与有界回收 |

矩阵测试覆盖 source/mineral/controller 热点规则、road 与区域叠加、施工点及同格多结构。路径测试必须含“未经过的边变便宜”、同 tick 多次改矩阵、后房间失效及合并后缀已经过期。不能只测正常命中。

过房方向编码和两单位同步让路必须在真实引擎验证；mock 不能证明结算时序。性能基准统计总 CPU P50/P95/P99、heap、实际 move 调用次数、方向表有效格比例，以及缓存建立/合并/失效开销；对照直接原生搜索，不只统计 search 本身。

## 12. 风险与待决参数

- 每 goal/room 固定 1250 字节适合同目标复用；大量短路径或随机目标可能浪费空间，先以 goal/字节上限控制，再以实测决定是否需要稀疏表示。
- 任一依赖更新整 goal 失效容易理解，但热点房间频繁建造会扩大重算；不以更细粒度索引换取未经证明的收益。
- 部分原生路径不进入共享方向表，搜索预算偏低时需待续任务才能建立完整跨房缓存；待续任务须严格限额。
- 同步让路允许请求者进入“计划释放”的格子，无法完全消除一次无效 move；双表负责纠正事实，不保证消除所有引擎冲突。
- 集中规划依赖业务在 begin 提供完整移动决策。仅在 execute 才能确定的任务，应延期登记，或另外审议框架阶段协议，不隐式改变调用顺序。
- 默认容量、CPU 预算、合并步数、冷却和重试阈值待基准确定。持久化启用前须验证 MemoryManager 迁移/pending/reset 的数据一致性。

## 13. 平台与项目依据

- [Game.map.findRoute](https://docs.screeps.com/api/#Game.map.findRoute)：房间路由的有向成本输入。
- [PathFinder.search](https://docs.screeps.com/api/#PathFinder.search)、[Room.findPath](https://docs.screeps.com/api/#Room.findPath)：搜索接口及结果契约。
- [CostMatrix](https://docs.screeps.com/api/#PathFinder.CostMatrix)、[Rampart.isPublic](https://docs.screeps.com/api/#StructureRampart.isPublic)：矩阵和平台通行属性。
- [Creep.move](https://docs.screeps.com/api/#Creep.move)：动作调用边界；平台返回成功与位置更新分开核验。
- 项目接入依据为 [Framework 设计](../core/framework.md)、[MemoryManager 设计](../core/memoryManager.md) 与 [公共契约](../contracts.md)。
