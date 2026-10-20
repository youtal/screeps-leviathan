# 模块设计：intershard（InterShardMemory 封装）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/kernel/intershard/` |
| 架构章节 | 4.2 依赖规则、5.6 boot 特权端口、6.9 InterShardMemory、11.4 附加规则 2；附录 A F7 |
| 成熟度 | 特性检测与本 shard 清空定稿 · M1；跨 shard 协议（6.9 的 `{sig, out, recv}`）方向 · M5，不在本文范围 |

## 1. 职责与范围

intershard 是 kernel 内部模块，是唯一访问 `InterShardMemory` 的模块（架构 4.2）。

M1 只交付 bootPort 需要的部分：开局清空的范围包括本 shard 的 InterShardMemory（11.4 附加规则 2），而 4.2 不允许 bootPort 直接访问它。派出清单、回执与跨 shard 识别在 M5 随 interShard 领域设计，届时补充本文。

## 2. 平台事实

| 事实 | 处理 |
| --- | --- |
| 私服不提供 `InterShardMemory`（F7） | 每次调用时检测，不可用时什么也不做 |
| 每个 shard 只能写自己的那一份（`setLocal`），内容是字符串 | 清空即写入空字符串 |

## 3. 接口（kernel 内部）

```ts
interface InterShardHost {
  available(): boolean;   // 运行环境是否提供 InterShardMemory
  clearLocal(): void;     // 可用时把本 shard 的内容写为空字符串；不可用时什么也不做
}
```

- 创建时由宿主注入安装全局对象的目标（游戏中为 `globalThis`，测试中为隔离对象），模块在调用时读取其上的 `InterShardMemory`，不在模块加载时读取。
- `clearLocal()` 不捕获平台异常，由 bootPort 的 `clearInterShard()` 原样抛给 boot（[bootPort](./bootPort.md#3-操作)）。
- 没有 heap 状态，也没有每 tick 的固定成本。

## 4. 验证

单元测试以注入的目标对象覆盖：不提供 `InterShardMemory` 时 `available()` 为 false、`clearLocal()` 不抛错也不写入；提供时写入空字符串；平台异常原样传播。边界测试已把 `kernel/intershard/` 列为存储所有者。官服行为在 M5 随跨 shard 协议验证。
