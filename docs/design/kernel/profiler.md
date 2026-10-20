# 模块设计：profiler

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/kernel/profiler/` |
| 架构章节 | 4.5 profiler（计时与性能统计）、5.3 计量、5.8 可观测性；契约见 [contracts](../contracts/README.md) 第 4 节 `Measure` |
| 成熟度 | 定稿 · M1 |

## 职责与边界

实现 `Measure` 契约：按标签聚合 CPU 耗用，以只读快照供诊断读取。

- **只放 heap**：计时是诊断数据，丢失只影响平滑值的预热，不影响运营正确性；写入主 Memory 会让一个存储单元每 tick 变脏。
- **与 cpu 计量分开**：准入与统计所用的进程耗用来自 [cpu](./cpu.md) 的平滑计量，不依赖 profiler；统计页（[stats](./stats.md)）写出的是 cpu 的进程耗用，不读取本模块的快照。profiler 按标签提供更细的计时明细，M1 中没有读取快照的使用方，快照接口保留给后续的诊断命令。
- **零依赖**：CPU 读数由装配方注入（游戏中为 `Game.cpu.getUsed`）；不写日志，不访问 Memory 与 segment。
- **计时粒度由调用方决定**：profiler 只负责聚合；kernel 默认只对模块级钩子计时，实例级明细是否计时由 kernel 的配置决定。原因是每次计时都要读 `Game.cpu.getUsed()`，并非零成本。kernel 的阶段循环不调用 `begin`，而是把 cpu 计量的读数作为开始读数传给 `end`，每次计时只多读一次（[cpu](./cpu.md#5-计量)）。

## 接口

```ts
interface ProfilerOptions {
  readonly cpuUsed: () => number;
  readonly maxLabels?: number;           // 标签数量上限，默认 PROFILE_MAX_LABELS
}

interface ProfileEntry {
  readonly label: string;                // '<作用域>.<op>'
  readonly tick: number;                 // 上一个完整 tick 的累计耗用
  readonly calls: number;                // 上一个完整 tick 的调用次数
  readonly average: number;              // 每 tick 耗用的指数平滑值
}

interface Profiler {
  scope(prefix: string): Measure;        // 计时标签为 `${prefix}.${op}`
  beginTick(): void;                     // 每 tick 开始时调用，结算上一 tick 并清零本 tick 累计
  snapshot(): readonly ProfileEntry[];   // 新数组；供诊断低频读取
  readonly overflow: number;             // 因超过标签上限而丢弃的计时次数（累计）
}
```

## 聚合规则

- 每个标签保存：本 tick 累计、本 tick 调用次数、上一 tick 累计与次数、平滑值。
- `beginTick` 时，对每个标签执行 `average = average × (1 − α) + 上一 tick 累计 × α`，α = `PROFILE_ALPHA`（0.1，约等于近 10 tick 的窗口）；本 tick 未调用的标签按 0 计入，平滑值逐渐衰减。然后把本 tick 累计转为"上一 tick"，清零累计。首次出现的标签以第一次结算值作为平滑初值。
- 标签数量超过上限时，不再创建新标签，丢弃该次计时并累加 `overflow`。架构 5.8 要求标签不含 tick、creep 名等无界字段，上限用来防止误用导致 heap 无限增长。
- `scope(prefix)` 返回的 `Measure` 在作用域内缓存 `op → 标签记录`，`end` 不必每次拼接字符串；该缓存同样计入上限。
- 结算成本与标签数成正比，每 tick 一次。

## 参数

| 名称 | 默认值 | 含义 |
| --- | --- | --- |
| `PROFILE_ALPHA` | 0.1 | 平滑系数 |
| `PROFILE_MAX_LABELS` | 500 | 标签数量上限 |

## 验证

单元测试使用注入的 CPU 读数，覆盖：
- 标签拼接；
- 同 tick 多次调用累计；
- `beginTick` 结算与清零；
- 平滑值的计算与衰减；
- 标签上限与 `overflow`；
- 快照为新数组且不暴露内部记录。
