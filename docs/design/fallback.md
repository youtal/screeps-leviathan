# 模块设计：保底循环

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/fallback.ts` |
| 架构章节 | 5.7 保底循环 |
| 成熟度 | 定稿 · M1 |

## 职责与边界

正常循环无法运行时，用不足 400 行有效代码维持本房的生存闭环：防御、应急孵化、简单能量物流与防降级。约束全部来自架构 5.7：
- 不导入任何项目模块（由边界测试检查）；
- 保底代码自身不读写任何持久化存储。引擎的 `spawnCreep` 无论是否传 `memory` 选项，都会访问 `Memory.creeps`，所以入口必须在调用保底前完成 Memory 接管，使这类引擎内部写入落在临时对象上（[内核骨架](./kernel/README.md) 第 6 节）；
- 不建立持久任务；
- 按房间与单个资产隔离异常。

入口只导出 `runFallback(): void`，由 `main.ts` 按 [内核骨架](./kernel/README.md) 第 6 节的规则调用。

## 执行顺序与 CPU 预算

每 tick 先确定 CPU 上限：bucket 不足 1000 时取 `Game.cpu.limit`，否则取 `Game.cpu.tickLimit`，再留出退出余量 `FB_CPU_RESERVE`（2 CPU）。处理每个房间与每个资产前都检查已用 CPU，包括收集房间事实之前，超出上限即停止本 tick 的剩余工作。

每个自有房间先收集一次事实快照：敌人、己方建筑、全部建筑、己方 creep、source、mineral、己方工地、掉落能量、墓碑与废墟，每类对象只查询一次，后续各阶段复用。工作按优先级分阶段进行：

1. **防御**：所有自有房间的 tower 攻击最近的敌方 creep；没有敌人、且 tower 能量不低于容量一半时，治疗受伤的己方 creep。
2. **应急孵化**：房间没有可用采集者，且没有正在孵化的带 WORK 接替者时，由空闲 spawn 用 200 能量孵化 `[WORK, CARRY, MOVE]`。
   - 可用采集者：具有有效 WORK，并且能移动或已经紧挨 source 的 creep，含没有 CARRY 的矿工。这一判定与第 3 阶段的实际驱动一致，被计入的 creep 都会去采集。
   - 接替者：`FIND_MY_CREEPS` 不含孵化中的 creep，所以从各 spawn 的 `spawning.name` 到 `Game.creeps` 查找。这也覆盖正常循环在当 tick 已经开始孵化的情形。
3. **creep 工作**：逐个处理自有房间内不在孵化中的 creep，防降级升级者最先处理；每个 creep 每 tick 至多一个工作动作和一次移动。

房间与单个资产（tower、spawn、creep）各有错误边界：一个房间的查询抛错不影响其他房间，一个资产抛错不影响同房间的其他资产。

## creep 的分工

角色只从有效身体部件推断，不使用任何记录：

| 类别 | 条件 | 行为 |
| --- | --- | --- |
| 固定 creep | 没有有效 MOVE | 只执行当前位置能完成的动作，按优先级：是防降级升级者时升级、向相邻补能目标转移、采集相邻 source（空余容量不足时多出的能量落地）、在范围内升级、拾取或提取相邻能量。转移与提取都使用当 tick 预留 |
| 矿工 | 有 WORK 与 MOVE、没有 CARRY | 前往最近的活跃 source 采集，能量按引擎规则落地，供搬运者拾取 |
| 工人 | 有 WORK、CARRY 与 MOVE | 是防降级升级者时：有能量就升级，否则先取能。<br>平时：紧挨活跃 source 且未装满时继续采集；否则有能量就补能，没有补能目标时升级；空载时取能，没有可取能量时采集 source |
| 搬运者 | 有 CARRY 与 MOVE、没有 WORK | 有能量就补能，空载时取能 |

- **补能目标**：按 spawn、extension、能量低于一半的 tower 的顺序挑选最近的一个；有敌人时 tower 优先。
- **取能来源**：掉落能量、墓碑、废墟、container、storage 中最近的一个。
- **当 tick 预留**：以对象 id 记录本 tick 已分配的剩余量，供给按 creep 的空余容量扣减，补能目标按其空余容量扣减。避免多个 creep 争抢同一小额供给，或重复补满同一目标。
- **防降级应急**：控制器剩余降级时间低于 `CONTROLLER_DOWNGRADE[level] × FB_DOWNGRADE_RATIO`（0.25）时，每个房间每 tick 选出一个升级者并最先处理。优先选带能且能立即升级的工人（可移动，或固定但已在升级范围内），取离控制器最近者；没有时选最近的可移动工人先去取能。
- **取能后不连带后续动作**：刚提交的取能不算已经拿到能量，本 tick 不再据此提交升级或转移。

## 移动与寻路

- 不使用 `moveTo`，它可能把路径缓存写进 creep 的 memory。
- 需要移动时，用 `PathFinder.search` 只在本房间内寻路（`maxRooms: 1`，`maxOps` 为 `FB_PATH_OPS`，默认 1000），再用 `creep.move` 走出第一步。
- 每个房间每 tick 至多构建一次成本矩阵：道路记为 1；container 与己方或公共 rampart 视为可通过；其余建筑，以及原生寻路不认识、移动结算却会阻挡的 source、mineral、controller 与己方阻挡类工地（`OBSTACLE_OBJECT_TYPES`）记为 255。
- 全局每 tick 至多寻路 `FB_PATH_LIMIT`（默认 20）次，超出的 creep 本 tick 原地不动。

## 命名

应急 creep 名为 `fb-<来源 shard>-<完整 tick 的 base36>-<同 tick 序号>`。来源 shard 取身份用的 shard 名（11.3 的 `here`）：有 `InterShardMemory` 时为 `Game.shard.name`，否则为 `x`。私服的 `Game.shard` 是 driver 注入的主机名（F7），不使用；`typeof InterShardMemory` 只做特性检测，不读写其内容。生成前检查 `Game.creeps`（含孵化中的 creep）和本 tick 已分配的名称。正常循环恢复后，这些 creep 按事实进入遗留池再被认领；应急前缀不作为清空 Memory 的签名证据。

## 参数

| 名称 | 默认值 | 含义 |
| --- | --- | --- |
| `FB_CPU_RESERVE` | 2 CPU | 退出余量 |
| `FB_DOWNGRADE_RATIO` | 0.25 | 防降级应急阈值占 `CONTROLLER_DOWNGRADE` 的比例 |
| `FB_PATH_LIMIT` | 20 | 每 tick 寻路次数上限 |
| `FB_PATH_OPS` | 1000 | 单次寻路的 `maxOps` |

## 验证

- 单元测试以构造的游戏对象替身驱动。替身遵守与本模块相关的平台语义：`FIND_MY_CREEPS` 不含孵化中的 creep；寻路调用 `roomCallback` 并保存矩阵；`spawnCreep` 访问 `Memory.creeps`。覆盖：
  - 防御与治疗；
  - 应急孵化的条件、名称与去重，以及孵化中接替者的判断；
  - 固定 creep 与无 CARRY 矿工的采集；
  - 工人与搬运者的取能、补能、防降级升级者的选择与优先处理；
  - 预留避免重复分配，固定 creep 同样使用；
  - CPU 不足时在收集房间事实之前停止，每类对象每房每 tick 只查询一次；
  - 成本矩阵包含非建筑障碍；
  - 房间级与资产级异常隔离；
  - 保底代码自身不触碰 Memory，以及 spawnCreep 对入口接管的依赖。
- 边界测试保证不导入项目模块。
- 有效代码行数由测试统计，不超过 400 行。
- 真实行为在私服混沌测试中复核（M1 第 7 步）。
