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
| app | [app/assembly.md](./app/assembly.md) | 装配：模块清单、boot、Memory 身份、平台注入与使用者设置 |
| app | [app/boot.md](./app/boot.md) | 启动判定：事实、Memory 状态、判定顺序、闸门与项目标记维护 |
| app | [app/config.md](./app/config.md) | 劳动力配置、身体模板、孵化优先级与运营参数 |
| app | [app/ops.md](./app/ops.md) | 运维命令与模块启停标志 |
| contracts | [contracts/README.md](./contracts/README.md) | 注入接口与跨模块协议 |
| kernel | [kernel/README.md](./kernel/README.md) | 内核骨架：宿主接口、tick 流水线、进程表、上下文、日志、入口切换 |
| kernel | [kernel/errorMapper.md](./kernel/errorMapper.md) | 错误规范化与源码映射 |
| kernel | [kernel/profiler.md](./kernel/profiler.md) | 计时聚合（只放 heap） |
| kernel | [kernel/cpu.md](./kernel/cpu.md) | CPU 分层准入、每 tick 预算与平滑计量 |
| kernel | [kernel/stats.md](./kernel/stats.md) | kernel 运行指标与统计 segment（第 50 页） |
| kernel | [kernel/console.md](./kernel/console.md) | 控制台命令注册、全局命名空间与调用隔离 |
| kernel | [kernel/memory.md](./kernel/memory.md) | Memory v1 与候选块级优化 |
| kernel | [kernel/segments.md](./kernel/segments.md) | Segment 整页覆盖写入（备份区与统计） |
| kernel | [kernel/bootPort.md](./kernel/bootPort.md) | boot 特权端口：概要、备份、初始化、清空、软重置 |
| kernel | [kernel/intershard.md](./kernel/intershard.md) | InterShardMemory 封装：M1 的特性检测与本 shard 清空 |
| lib | [lib/hash.md](./lib/hash.md) | 稳定字符串哈希（校验位、错峰、分片） |
| lib | [lib/naming.md](./lib/naming.md) | creep 名称的格式化与校验，spawn 名称词库 |
| lib | [lib/geometry.md](./lib/geometry.md) | 房间坐标、坐标打包、方向与距离 |
| lib | [lib/tables.md](./lib/tables.md) | 按 RCL 查询的建筑与控制器常量表 |
| lib | [lib/body.md](./lib/body.md) | 身体组成：成本、体型展开与排列、用途分类、实际能力与移动速度 |
| lib | [lib/combat.md](./lib/combat.md) | tower 距离衰减、creep 战斗能力与承受伤害 |
| lib | [lib/grid.md](./lib/grid.md) | 网格原语：距离变换、多源 BFS、洪水填充、邻居枚举 |
| lib | [lib/layout.md](./lib/layout.md) | 中央枢纽判定与 3×3 核心模板 |
| lib | [lib/collections.md](./lib/collections.md) | 泛型优先队列、分桶队列与 LRU 缓存 |
| world | [world/market.md](./world/market.md) | 物价模型 |
| colony | [colony/inventory.md](./colony/inventory.md) | 资源库存控制 |
| domains | [domains/industry/economics.md](./domains/industry/economics.md) | 产业规划 |

## 规则

- 模块设计文档开头的表格注明源码位置、对应的架构章节与成熟度。模块交付后补充"接口与用法"一节：初始化、公共 API、参数、返回值、配置、调用示例、错误处理与注意事项。
- 成熟度为"方向"的模块，实施前先在对应位置完成模块设计文档。
- 源码目录新增、移动或更名时，同步移动对应的设计文档，并更新本索引与所有引用。
