# 设计文档

设计文档只写设计意图，不写项目现状、历史变更或现状与目标的对照。

## 目录与源码的对应

| 位置 | 内容 |
| --- | --- |
| `architecture.md` | 总体架构、模块职责与跨模块契约；各节标注成熟度（定稿、方向、候选）；附录 B 为参数参考 |
| `runbook.md` | 运维手册：部署、回滚、接手、恢复、跨 shard（M2 建立） |
| `<层>/README.md` | 该层内跨模块的设计，按需建立 |
| `<层>/<模块>.md` | 模块设计，与 `src/<层>/<模块>/` 一一对应；领域模块为 `domains/<分组>/<领域>.md` |

层与 `src/` 下的目录一致：`kernel`、`lib`、`world`、`services`、`colony`、`domains`、`contracts`、`app`。

## 索引

| 层 | 文档 | 内容 |
| --- | --- | --- |
| — | [architecture.md](./architecture.md) | 总体架构 |
| app | [app/config.md](./app/config.md) | 劳动力配置、身体模板、孵化优先级与运营参数 |
| contracts | [contracts/README.md](./contracts/README.md) | 注入接口与跨模块协议 |
| kernel | [kernel/memory.md](./kernel/memory.md) | Memory 块级标脏与分级序列化缓存 |
| world | [world/market.md](./world/market.md) | 物价模型 |
| colony | [colony/inventory.md](./colony/inventory.md) | 资源库存控制 |
| domains | [domains/industry/economics.md](./domains/industry/economics.md) | 产业规划 |

## 规则

- 模块设计文档开头的表格注明源码位置、对应的架构章节与成熟度。模块交付后补充"接口与用法"一节：初始化、公共 API、参数、返回值、配置、调用示例、错误处理与注意事项。
- 成熟度为"方向"的模块，实施前先在对应位置完成模块设计文档。
- 源码目录新增、移动或更名时，同步移动对应的设计文档，并更新本索引与所有引用。
