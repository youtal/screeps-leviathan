# 模块设计：tables（常量表）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/lib/tables/` |
| 架构章节 | 4.5 tables、9.6 布局规划、10.6 建造与维修、附录 A F16–F17 |
| 成熟度 | RCL 部分定稿 · M2；反应与商品配方 · M6 |

## 1. 职责

按 RCL 查询的建筑与控制器常量，以及由它们派生的查询：

| 使用方 | 用途 |
| --- | --- |
| planner | 每个建筑的解锁 RCL（9.6） |
| build | 当前 RCL 下的建筑数量上限、rampart 血量上限（10.6） |
| upgrade、stage | 控制器降级时长、升级所需进度 |
| 各领域、app.config | 各 RCL 的能量容量，用于估算体型 |

## 2. 数据来源

数值抄自 `@screeps/common` 2.16.1 的 `constants.js`，以冻结数组保存，下标就是 RCL（0–8），不在运行时读取游戏全局常量。这样调用方与测试都不依赖全局替身，函数是真正的纯函数。

代价是官方修改常量时不会自动跟随。单元测试逐项比对场景镜像中的采样（`test/lib/fixtures/engine-constants.json`，生成器为同目录的 `engine-constants.gen.cjs`），引擎版本更新时重新采样即可发现差异。

| 表 | 引擎常量 | 说明 |
| --- | --- | --- |
| `STRUCTURE_LIMITS` | `CONTROLLER_STRUCTURES` | 每种可建造建筑在 RCL 0–8 的数量上限；container 与 road 在 RCL 0 也可建造 |
| `EXTENSION_CAPACITY` | `EXTENSION_ENERGY_CAPACITY` | 单个 extension 的容量 |
| `RAMPART_MAX_HITS` | `RAMPART_HITS_MAX` | RCL 0–1 记为 0 |
| `DOWNGRADE_TICKS` | `CONTROLLER_DOWNGRADE` | RCL 0 记为 0 |
| `UPGRADE_PROGRESS` | `CONTROLLER_LEVELS` | 从该级升到下一级的进度；RCL 0 与 8 记为 0 |
| `SPAWN_CAPACITY` | `SPAWN_ENERGY_CAPACITY` | 300 |

导出名不与游戏全局常量同名，避免在同一文件中遮蔽全局常量造成误读。

## 3. 派生查询

- `structureLimit(type, rcl)`：RCL 小于 0 或为 NaN 时按 0，大于 8 按 8，非整数向下取整。
- `unlockLevel(type, n)`：第 n 个（从 1 起）某类建筑最早允许存在的 RCL，即上限表中第一个不小于 n 的下标；超出 RCL 8 的上限时为 `undefined`。
- `energyCapacityAt(rcl)`：建满 spawn 与 extension 时的能量容量，不计 power creep 效果。

查询只做数组下标访问，不分配对象。

## 4. 接口与用法

```ts
MAX_RCL = 8
SPAWN_CAPACITY = 300
STRUCTURE_LIMITS: Record<BuildableStructureConstant, ByRcl>  // 下标为 RCL 0–8
EXTENSION_CAPACITY, RAMPART_MAX_HITS, DOWNGRADE_TICKS, UPGRADE_PROGRESS: ByRcl

structureLimit(type, rcl): number
unlockLevel(type, n): number | undefined        // unlockLevel('extension', 6) === 3
energyCapacityAt(rcl): number                   // RCL 1–4：300、550、800、1300
```

## 5. 验证

单元测试逐项比对各表与引擎常量，覆盖等级规范化、`unlockLevel` 与逐级扫描定义的一致性（全部建筑类型、n = 1–61）、各 RCL 的能量容量，以及表的冻结。
