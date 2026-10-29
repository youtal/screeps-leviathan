# 模块设计：layout（布局模式）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/lib/layout/` |
| 架构章节 | 4.5 layout、7.4 hub、9.6 布局规划、9.7 中央物流枢纽 |
| 成熟度 | 定稿 · M2 |

## 1. 职责

布局模式的共享定义：中央枢纽判定 `matchHub` 与 3×3 核心模板 `CORE_TEMPLATES`。world.hub 用前者依据实际建筑检测枢纽，planner 用后者设计核心；两者都只依赖本模块，彼此之间没有依赖（7.4）。

## 2. 枢纽判定

`matchHub(tileFree, adjacent)` 按 7.4 判定候选格 T：

1. T 不是墙，上面没有建筑——由调用方依据地形与建筑判断，以 `tileFree` 传入；
2. 至少 1 个 spawn 与 T 相邻；
3. storage 与 T 相邻；
4. 另外至少 1 个伙伴建筑与 T 相邻：link、terminal、factory、powerSpawn、nuker。

`adjacent` 是与 T 相邻的本方建筑，所有权由调用方过滤。函数是泛型的：输入元素只需带 `structureType`，结果中原样返回这些元素（`spawns` 按输入顺序，`storage` 与每类伙伴取第一个），不复制、不读取 Game。不满足任一条件时返回 `null`。

枢纽格一定与 storage 相邻，所以 world.hub 只需检查 storage 周围的最多 8 个候选格。

## 3. 核心模板

以枢纽格为原点（y 轴向下），朝向 0 的模板为：

```text
     R  R  R
  R  S  St S  R
  R  L  ·  T  R
  R  N  F  P  R
     R  R  R
```

| 位置 | 建筑 |
| --- | --- |
| 中心 `·` | 不放建筑，留给中央枢纽 creep |
| 正方向（顺时针） | storage `St`（上）、terminal `T`（右）、factory `F`（下）、link `L`（左） |
| 斜角 | 上方两角为 spawn `S`（靠近 storage 一侧），右下 powerSpawn `P`，左下 nuker `N` |
| 外圈 | 5×5 去掉四角与内圈的 12 格道路 `R` |

- 朝向 1–3 依次顺时针旋转 90°，storage 位于枢纽格的右、下、左方；planner 选择使 storage 朝向基地重心的朝向（9.6）。旋转在屏幕坐标中为 `(dx, dy) → (−dy, dx)`。
- 每个模板 20 格，各格顺序在四种朝向间一致；模板与其中的每格都已冻结。
- 模板只描述位置与建筑类型。两个 spawn 分别在 RCL 1 与 RCL 7 建造、各建筑的解锁 RCL 与放置顺序由 planner 决定。

## 4. 接口与用法

```ts
HUB_PARTNER_TYPES = ['link', 'terminal', 'factory', 'powerSpawn', 'nuker']

matchHub<T extends { structureType: string }>(tileFree: boolean, adjacent: readonly T[]):
  { spawns: T[]; storage: T; partners: Partial<Record<HubPartnerType, T>> } | null

CORE_TEMPLATES: readonly (readonly { dx, dy, structure }[])[]   // 下标为 CoreOrientation 0–3
```

## 5. 验证

单元测试覆盖 `matchHub` 的四个条件、每类伙伴、取第一个元素与原样返回；四种朝向的模板都满足 `matchHub` 并包含全部伙伴（共享定义的保证）；模板形状（内圈 8 个核心建筑、外圈 12 格道路、枢纽格为空）、旋转关系与冻结。
