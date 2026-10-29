# 模块设计：body（身体组成）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/lib/body/` |
| 架构章节 | 4.5 body、8.2 spawnQueue、10.3 身体生成、11.6 接手（用途分类）、附录 A F14、F16 |
| 成熟度 | 定稿 · M2 |

## 1. 职责

身体组成的纯函数：常量、部件计数、成本与孵化时间、体型展开与排列、用途分类，以及依据实际部件状态（伤损与 boost）的经济能力与移动速度。战斗能力与承受伤害在 [combat](./combat.md)。

体型模板与各角色的规模规则写在 [app.config](../app/config.md#body-templates)：config 的 `bodyFn`（8.2）组合本模块的函数得到部件计数，再由 `arrange` 排成 `spawnCreep` 的部件数组。本模块不保存模板，也不依赖运行期任务状态。

## 2. 数据

部件成本（`BODYPART_COST`）、boost 倍率（`BOOSTS`）与各动作基数（`HARVEST_POWER` 等）抄自 `@screeps/common` 2.16.1，理由与校验方式同 [tables](./tables.md#2-数据来源)。`boostFactor(type, boost, method)` 与引擎 `calcBodyEffectiveness` 的取值规则相同：没有 boost、化合物不适用于该部件或该动作时为 1。

## 3. 部件计数与体型

- **计数**：`BodyCounts` 以部件类型为键，字段按 `BODY_ORDER` 的固定顺序创建，所有计数对象共享同一隐藏类（12.1）。`countParts` 统计部件数组，`activeCounts` 只计 hits > 0 的部件。
- **成本与时间**：`countsCost`、`bodyCost`；`spawnTime(部件数) = 部件数 × 3`；`lifeTime` 在含 CLAIM 时为 600，否则为 1500。
- **展开**：`fit(spec, energy)` 处理"固定部分 + 若干重复单元"的形态：

```text
n = min(maxUnits, ⌊(能量 − 固定成本) / 单元成本⌋, ⌊(50 − 固定部件数) / 单元部件数⌋)
```

  n 小于 `minUnits`（缺省为 1），或固定部分本身放不下时返回 `undefined`。不能写成重复单元的模板（例如升级者的 `[WORK×k, CARRY, MOVE×⌈k/2⌉]`）由 `bodyFn` 直接计算计数。能量取能量上限还是当前可用能量由调用方决定（app.config：平时按上限满配，紧急时按当前能量）。
- **排列**：`arrange` 按 `BODY_ORDER` 输出部件数组：

```text
TOUGH → CLAIM → CARRY → WORK → ATTACK → RANGED_ATTACK → HEAL → MOVE
```

  伤害从身体最前端的部件开始扣除（engine `processor/intents/creeps/tick.js`），所以 TOUGH 在最前承受伤害，MOVE 在最后使受伤后仍能移动；CLAIM 与 CARRY 价值较低、靠前，攻击、远程与治疗靠后，尽量晚失效。

## 4. 用途分类

`classify(counts)` 只按部件计数推断用途，供接手与自我认领（11.6）。结合位置的判断（例如"source 旁 WORK 多"）由领域完成；判断接手资产时应传 `activeCounts` 的结果，已失效的部件不提供能力。

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 有 CLAIM | `claimer` |
| 2 | 有治疗或攻击部件：治疗数 ≥ 攻击与远程之和 | `healer` |
| | 否则攻击数 ≥ 远程数 | `melee` |
| | 否则 | `ranged` |
| 3 | 有 WORK：没有 CARRY，或 WORK ≥ 5 且 CARRY ≤ 1 | `miner`（与 app.config 的矿工体型一致） |
| | 否则 | `worker` |
| 4 | 有 CARRY | `hauler` |
| 5 | 只有 MOVE | `scout` |
| 6 | 没有有效部件，或只有 TOUGH | `inert` |

## 5. 实际能力与移动速度

输入为 `PartState { type, hits, boost? }` 数组，游戏的 `creep.body` 可以直接传入。

- **经济能力**：`capabilities(body)` 一次遍历给出每 tick 的采集、建造、维修、拆除、升级、携带容量与 MOVE 倍率之和，只计 hits > 0 的部件并乘以 boost 倍率（engine `utils.js` 的 `calcBodyEffectiveness`）。升级在 RCL8 另受每 tick 15 的上限，由调用方处理。`partPower(body, type, method)` 给出单项倍率之和。
- **负重**：`fatigueWeight(body, carried)` 与 engine `processor/intents/movement.js` 一致：非 MOVE 且非 CARRY 的部件数（含已失效的部件），加上装载中的 CARRY 数；装载中的 CARRY 从身体末尾起，按有效部件与 boost 后容量依次装满计数。
- **速度**：走一格产生 `负重 × 地形系数` 的 fatigue（道路 1、平原 2、沼泽 10），每 tick 恢复 `2 × MOVE 倍率之和`。`stepTicks(weight, movePower, terrain) = max(1, ⌈负重 × 地形系数 / (2 × MOVE 倍率之和)⌉)`；没有有效 MOVE 时为 `Infinity`。

## 6. 接口与用法

```ts
// 常量
MAX_PARTS = 50, SPAWN_TICKS_PER_PART = 3, CREEP_LIFE_TIME = 1500, CREEP_CLAIM_LIFE_TIME = 600, CARRY_CAPACITY = 50
HARVEST_POWER, BUILD_POWER, REPAIR_POWER, DISMANTLE_POWER, UPGRADE_POWER
PART_COST, BOOST_EFFECTS, BODY_ORDER, TERRAIN_FATIGUE
boostFactor(type, boost, method): number

// 计数与体型
emptyCounts(): BodyCounts
countParts(parts): BodyCounts
partTotal(counts) / countsCost(counts) / bodyCost(parts) / spawnTime(partCount) / lifeTime(counts)
fit({ fixed?, unit, minUnits?, maxUnits? }, energy): BodyCounts | undefined
arrange(counts): BodyPartConstant[]
classify(counts): BodyClass

// 实际部件
activeCounts(body): BodyCounts
partPower(body, type, method): number
capabilities(body): { harvest, build, repair, dismantle, upgrade, capacity, move }
fatigueWeight(body, carried): number
stepTicks(weight, movePower, terrain): number
```

```ts
// 通用工人：每单元 [WORK, CARRY, MOVE]，最多 5 个单元（app.config 第 3 节）
const counts = fit({ unit: { work: 1, carry: 1, move: 1 }, maxUnits: 5 }, room.energyCapacityAvailable);
if (counts !== undefined) spawn.spawnCreep(arrange(counts), name);
```

- 计数、成本与展开的输入是部件计数，缺少的字段按 0；`countParts`、`activeCounts`、`fit`、`emptyCounts` 返回新对象，调用方可以原地修改。
- `capabilities` 每次新建一个结果对象，其余函数不分配。

## 7. 验证

单元测试比对常量与引擎一致；在 300 个随机身体（伤损、boost、携带量）上，`partPower` 与引擎 `calcBodyEffectiveness`、`fatigueWeight` 与引擎负重逐项一致（采样以引擎原文函数在场景镜像中运行，见 [tables](./tables.md#2-数据来源)）。另覆盖计数与成本、`fit` 的能量与部件上限、`arrange` 的顺序、`classify` 的判断顺序与 `stepTicks` 的典型配比。
