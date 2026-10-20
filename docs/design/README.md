# 设计文档

设计文档只写设计意图，不写项目现状、历史变更或现状与目标的对照。

## 目录与源码的对应

| 位置 | 内容 |
| --- | --- |
| `architecture.md` | 总体架构、模块职责与跨模块契约；各节标注成熟度（定稿、方向、候选）；附录 B 为参数参考 |
| `runbook.md` | 运维手册：部署、回滚、接手、恢复、跨 shard（M2 建立） |
| `<层>/README.md` | 该层内跨模块的设计，按需建立 |
| `<层>/<模块>.md` | 模块设计，与 `src/<层>/<模块>/` 一一对应；领域模块为 `domains/<分组>/<领域>.md` |

层与 `src/` 下的目录一致：`kernel`、`lib`、`world`、`services`、`colony`、`domains`、`contracts`、`app`。`src/` 根目录下的独立文件（`fallback.ts`）对应 `docs/design/` 根目录下的同名文档。

## 索引

| 层 | 文档 | 内容 |
| --- | --- | --- |
| — | [architecture.md](./architecture.md) | 总体架构 |
| — | [fallback.md](./fallback.md) | 独立保底循环（`src/fallback.ts`） |
| app | [app/config.md](./app/config.md) | 劳动力配置、身体模板、孵化优先级与运营参数 |
| contracts | [contracts/README.md](./contracts/README.md) | 注入接口与跨模块协议 |
| kernel | [kernel/README.md](./kernel/README.md) | 内核骨架：宿主接口、tick 流水线、进程表、上下文、日志、入口切换 |
| kernel | [kernel/errorMapper.md](./kernel/errorMapper.md) | 错误规范化与源码映射 |
| kernel | [kernel/profiler.md](./kernel/profiler.md) | 计时聚合（只放 heap） |
| kernel | [kernel/memory.md](./kernel/memory.md) | Memory v1 与候选块级优化 |
| kernel | [kernel/segments.md](./kernel/segments.md) | Segment 整页覆盖写入（备份区与统计） |
| kernel | [kernel/bootPort.md](./kernel/bootPort.md) | boot 特权端口：概要、备份、初始化、清空、软重置 |
| kernel | [kernel/intershard.md](./kernel/intershard.md) | InterShardMemory 封装：M1 的特性检测与本 shard 清空 |
| world | [world/market.md](./world/market.md) | 物价模型 |
| colony | [colony/inventory.md](./colony/inventory.md) | 资源库存控制 |
| domains | [domains/industry/economics.md](./domains/industry/economics.md) | 产业规划 |

## 规则

- 模块设计文档开头的表格注明源码位置、对应的架构章节与成熟度。模块交付后补充"接口与用法"一节：初始化、公共 API、参数、返回值、配置、调用示例、错误处理与注意事项。
- 成熟度为"方向"的模块，实施前先在对应位置完成模块设计文档。
- 源码目录新增、移动或更名时，同步移动对应的设计文档，并更新本索引与所有引用。
