# 文档总导航

[项目首页](../README.md) · [开发规范](../AGENTS.md) · [设计索引](./design/README.md) · [使用索引](./usage/README.md) · [测试文档](./testing/README.md) · [更新记录](./changelog/README.md) · [审计报告](./audits/README.md)

设计记录设计意图和交付状态；使用说明记录公共能力的调用方法；更新记录保存已完成变更的历史。设计中的 API 示例不表示已可调用，使用时查看对应使用说明。

## 公共契约

[源码](../src/contracts/) · [设计](./design/contracts.md) · [使用说明](./usage/contracts.md)。跨模块协议集中发布，业务内部类型仍归所属模块。

## Core

总体设计见 [Core 架构及开发原则](./design/core/README.md)。

| 模块 | 源码 | 设计 | 使用说明 |
| --- | --- | --- | --- |
| Framework | [core/framework](../src/core/framework/) | [设计](./design/core/framework.md) | [使用](./usage/core/framework.md) |
| Runtime | [core/runtime](../src/core/runtime/) | [设计](./design/core/runtime.md) | [使用](./usage/core/runtime.md) |
| Profiler | [core/profiler](../src/core/profiler/) | [设计](./design/core/profiler.md) | [使用](./usage/core/profiler.md) |
| EventBus | [core/eventBus](../src/core/eventBus/) | [设计](./design/core/eventBus.md) | [使用](./usage/core/eventBus.md) |
| ErrorMapper | [core/errorMapper](../src/core/errorMapper/) | [设计](./design/core/errorMapper.md) | [使用](./usage/core/errorMapper.md) |
| Logger | [core/logger](../src/core/logger/) | [设计](./design/core/logger.md) | [使用](./usage/core/logger.md) |
| MemoryManager | [core/memoryManager](../src/core/memoryManager/) | [设计](./design/core/memoryManager.md) | [使用](./usage/core/memoryManager.md) |

## 业务模块与应用

| 模块 | 源码 | 设计 | 使用说明 |
| --- | --- | --- | --- |
| goto | 未交付；规划路径 `src/modules/goto/` | [设计](./design/modules/goto.md) | 待交付 |
| RoomShortcuts | [modules/roomShortcuts](../src/modules/roomShortcuts/) | [设计](./design/modules/roomShortcuts.md) | [使用](./usage/modules/roomShortcuts.md) |
| App | [app](../src/app/) | 装配原则见 Core 架构 | [项目入口](../README.md) |

## 工具

| 模块 | 源码 | 设计 | 使用说明 |
| --- | --- | --- | --- |
| 控制台格式化、表单和帮助 | [utils/console](../src/utils/console/) | [设计](./design/utils/console.md) | [使用](./usage/utils/console.md) |
| 优先队列 | [priorityQueue.ts](../src/utils/priorityQueue.ts) | [设计](./design/utils/priorityQueue.md) | [使用](./usage/utils/priorityQueue.md) |

## 测试环境

- [Screeps 4.3 引擎集成测试](./testing/integration.md)：安装原生依赖、运行场景、目录约定、覆盖边界与排错方法。

## 路径规则

模块目录 `src/<模块相对路径>/` 对应 `docs/design/<模块相对路径>.md` 与 `docs/usage/<模块相对路径>.md`，目录名及大小写保持一致，不逐个源码文件建立镜像。跨模块设计放在对应层级的 `README.md`。规划模块按目标路径放置设计，源码与使用说明未交付时明确标记。

模块文档移动或更名时同步所有引用。历史记录仍按日期组织；已有文档缺口在模块文档工作中补齐，不为凑齐目录生成虚构 API。
