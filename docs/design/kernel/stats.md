# 模块设计：stats（统计采集与统计 segment）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/kernel/stats/` |
| 架构章节 | 5.8 可观测性、6.8 页号分配（第 50 页）、13.4 线上监控 |
| 成熟度 | kernel 指标定稿 · M1；殖民地与经营指标（5.8 中的能源收支、库存、spawn 繁忙率等）随 M2 的使用方加入 |

## 1. 职责与范围

stats 在 heap 中累计一个窗口内的运行指标，按固定间隔把窗口摘要写入统计 segment，供外部采集端读取（exporter，M2）。它只写不读：统计是诊断数据，丢失只影响观测，不影响运营。

M1 只采集 kernel 自身能观测到的指标。5.8 中按殖民地记录的业务指标需要业务模块上报，接口（`ModuleContext.stats`）随第一个上报的模块在 M2 加入 contracts，本文届时补充。

## 2. 指标

| 指标 | 来源 | 窗口内的聚合 |
| --- | --- | --- |
| 每 tick 总耗用 | `Game.cpu.getUsed()`，收尾前读取 | 平均、最大 |
| kernel 收尾耗用 | Memory 维护之前与统计采集时两次读数之差，即 Memory 维护与提交的耗用 | 平均 |
| 各层耗用 | [cpu](./cpu.md) 的本 tick 计量（不含 boot，它不参与准入与计量） | 平均 |
| 预算 B、收尾预留 | cpu | 最后一个 tick 的值 |
| 被准入与落选的进程数 | cpu | 合计 |
| 耗用最高的进程 | cpu 的平滑耗用 | 写出时取前 `STATS_TOP` 个 |
| bucket | `Game.cpu.bucket` | 最小、最后 |
| 健康状态 | `tick()` 的返回值 | 各状态的 tick 数 |
| 熔断、初始化失败、运维暂停的模块 | 运行记录 | 写出时的清单 |
| 熔断次数 | 运行记录 | 窗口内新增次数 |
| 模式 | boot 发布的模式视图 | 写出时的值 |
| 版本号 | 构建注入的 `release` | 写出时的值 |
| Memory 体积 | `memory.sizes()` | 写出时的总量、各空间，以及体积最大的前 `STATS_MEMORY_TOP` 个 owner |
| 待写的 segment 页数 | segments | 写出时的值 |

- 标签与进程键都来自有限集合（contracts 第 4 节的约束），不含 tick、creep 名等无界字段。
- kernel 收尾耗用与按 owner 的体积是 14.4 候选优化的观测依据（[memory](./memory.md#1-触发条件)），也用于 M2 校准 5.3 的 kernel 固定开销。
- 保底循环是否接管由入口掌握，kernel 观测不到，所以不在统计页中。13.4 的"保底循环接管"告警由入口发出（[内核设计](./README.md#6-入口正常循环与保底循环)"接管通知"）。

## 3. 统计页

- **页号与 store**：第 50 页，store 为 `stats`，经 kernel.segments 的写入器以整页覆盖写出（[segments](./segments.md)），数据版本 `v` 为 1，`g` 为窗口结束的 tick。
- **写出间隔**：每 `STATS_INTERVAL` 个 tick 提交一次，提交后清空窗口。segments 在 bucket 低于 1000 时推迟写回 stats，推迟期间新的提交覆盖未写出的旧窗口，只保留最新一份。
- **正文**：一行 JSON，字段顺序固定：

```json
{"t":75012360,"n":20,"release":"0.1.10","mode":"NORMAL","health":{"ok":20,"degraded":0,"paused":0},
 "cpu":{"avg":3.1,"max":5.4,"finish":0.35,"b":21.5,"r":2.15,"tiers":{"survival":0.4,"economy":1.8,"maintenance":0.3,"planning":0}},
 "admit":{"admitted":412,"skipped":3},"bucket":{"min":9800,"last":9820},
 "top":[["mining:W1N1:5bbc…",0.42]],"breakers":2,"down":["lab"],"paused":["market"],
 "memory":{"total":182044,"spaces":{"sys":512,"part":30211,"rooms":80110,"creeps":71211,"flags":0},
  "owners":[["logistics",60120],["mining",41005]]},"segPending":0}
```

- 数值保留两位小数，减小体积。`top` 为 `[进程键, 平滑耗用]` 数组，按耗用从高到低；`memory.owners` 为 `[owner, 字符数]` 数组，按体积从大到小。
- **体积**：M1 的正文在 2 KB 以内。提交返回 `too-large` 时，清空 `top`、把 `down` 与 `paused` 各截为前 10 项、`memory.owners` 截为前 3 项后重试一次，仍超限则放弃本窗口并告警（6.8 安全规则 4）。

## 4. 时机与成本

- 每 tick 在收尾阶段累计：Memory 提交之后、segment 提交之前，读取 cpu 的本 tick 计量与 bucket，更新窗口内的几个数值，不分配对象。kernel 收尾耗用需要在 Memory 维护之前多读一次 `Game.cpu.getUsed()`。
- 写出的 tick 额外拼装一次正文：排序取前 `STATS_TOP` 个进程，O(进程数 × log)；按体积排序 owner，owner 数随模块数有界；`JSON.stringify` 一个小对象。
- 暂停 tick 照常累计。Memory 为 empty 或加载失败时，Memory 体积按缺失写出（字段为 `null`）；模式取 boot 发布的视图，总是存在。
- heap 状态只有当前窗口，global reset 与软重置后从新窗口开始；未写出的窗口丢失。

## 5. 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `STATS_INTERVAL` | 20 tick | 窗口长度与提交间隔 |
| `STATS_TOP` | 20 | 写出的高耗用进程数 |
| `STATS_MEMORY_TOP` | 10 | 写出的 Memory 体积最大的 owner 数 |

## 6. 接口与用法

kernel 内部接口，只由 kernel.lifecycle 在收尾阶段调用：

```ts
createStats({ writer, warn }): StatsHost   // writer：segments.writer('stats', STATS_VERSION)

interface StatsHost {
  record(tick: StatsTick, snapshot: () => StatsSnapshot): void; // 每 tick 一次；窗口满时调用 snapshot 并写出
  breaker(): void;                                               // 熔断发生时计数
}
```

- `StatsTick` 为本 tick 的耗用、kernel 收尾耗用、预算、各层耗用、准入计数、bucket 与健康状态；`StatsSnapshot` 为写出时的版本号、模式、高耗用进程、熔断与暂停的模块、Memory 体积（含体积最大的 owner）与待写页数，由 lifecycle 只在写出时生成。
- 外部采集端读取第 50 页：页头 `o` 为 `stats`、`v` 为 1；正文是一行 JSON，字段见第 3 节。

## 7. 验证

单元测试以严格平台模拟驱动 kernel：窗口聚合（平均、最大、最小、计数）；按间隔提交到第 50 页且页头正确；bucket 低时推迟写回并只保留最新窗口；超限时截短重试与放弃；暂停 tick 与 Memory 不可用时的写出；正文字段与示例结构一致。
