# 模块设计：combat（战斗估算）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/lib/combat/` |
| 架构章节 | 4.5 combat、7.5 threat、10.7 防御基线、12.3 公式 |
| 成熟度 | 定稿 · M2 |

## 1. 职责

tower 的距离衰减、单个 creep 的战斗能力与一次伤害实际扣除的 hits。world.threat 用它估算敌方编组的总伤害、总治疗与拆除能力（7.5），defense 用它计算集火净伤害、选择 tower 目标与防御者体型（10.7）。选择目标、组成编组等决策不在本模块。

## 2. tower

与 engine `processor/intents/towers/attack.js`、`heal.js`、`repair.js` 一致：

```text
距离 ≤ 5：基础值
否则：基础值 − 基础值 × 0.75 × (min(距离, 20) − 5) / 15，向下取整
```

| 动作 | 基础值 | 距离 ≥ 20 |
| --- | --- | --- |
| 攻击 `towerAttack` | 600 | 150 |
| 治疗 `towerHeal` | 400 | 100 |
| 维修 `towerRepair` | 800 | 200 |

攻击的结果即 12.3 的 `600 − (距离 − 5) × 30`。power creep 的 `PWR_OPERATE_TOWER`、`PWR_DISRUPT_TOWER` 不在模型内，需要时由调用方乘以效果倍率。

## 3. 战斗能力

`combatProfile(body)` 一次遍历给出每 tick 的近战伤害、单体远程伤害、相邻治疗、远程治疗与拆除量：有效部件（hits > 0）的 boost 倍率之和乘以 `ATTACK_POWER`（30）、`RANGED_ATTACK_POWER`（10）、`HEAL_POWER`（12）、`RANGED_HEAL_POWER`（4）、`DISMANTLE_POWER`（50），与引擎 `calcBodyEffectiveness` 一致。编组的合计由调用方按成员求和。

## 4. 承受伤害

`effectiveDamage(body, damage)` 与引擎 `_applyDamage`（`processor/intents/creeps/tick.js`）一致：从身体最前端的部件起依次承受伤害；boost 过的部件按其 damage 系数 k 减伤，该部件可吸收 `hits / k` 的原始伤害，其中 `1 − k` 的部分被抵消；减伤总量四舍五入后从原始伤害中扣除。只有 TOUGH 的化合物带 damage 系数（GO 0.7、GHO2 0.5、XGHO2 0.3），没有 boost 的身体不减伤。

- 输入的伤害是同一 tick 对该 creep 的原始伤害总和：引擎先累计再结算，分次调用会多算四舍五入。
- 结果可能超过 creep 剩余的 hits，此时即被击杀；集火净伤害按 10.7 为 `effectiveDamage(目标, tower 总伤害) − 编组可提供的治疗`。

## 5. 接口与用法

```ts
ATTACK_POWER, RANGED_ATTACK_POWER, HEAL_POWER, RANGED_HEAL_POWER
TOWER_POWER_ATTACK, TOWER_POWER_HEAL, TOWER_POWER_REPAIR, TOWER_OPTIMAL_RANGE, TOWER_FALLOFF_RANGE, TOWER_FALLOFF, TOWER_ENERGY_COST

towerAmount(base, range): number
towerAttack(range) / towerHeal(range) / towerRepair(range): number
combatProfile(body): { attack, rangedAttack, heal, rangedHeal, dismantle }
effectiveDamage(body, damage): number
```

输入的部件状态与 [body](./body.md#5-实际能力与移动速度) 的 `PartState` 相同。`combatProfile` 每次新建一个结果对象，其余函数不分配。

## 6. 验证

单元测试比对常量；tower 三种动作在距离 0–50 上与引擎公式逐项一致，攻击另与 12.3 的公式比对；300 个随机身体上 `effectiveDamage` 与引擎 `_applyDamage` 原文的结果一致（其中有减伤的样本超过 50 个），`combatProfile` 与引擎 `calcBodyEffectiveness` 一致（采样见 [tables](./tables.md#2-数据来源)）。
