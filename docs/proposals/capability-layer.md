# 提案：通用能力层的定位与提供方式

- 状态：待决策
- 提出日期：2026-09-23
- 范围：roomShortcuts、goto 这类“与 Screeps 强耦合、但为其他业务模块提供通用能力”的模块，如何被定位与消费
- 导航：[提案索引](./README.md)

## 1. 要解决的问题

内核能力由 Runtime 组装并交给 Framework 消费，这条链路是清晰的。但还有一类模块处境不同：

- 它们与 Screeps 环境高度耦合（房间、建筑、地形、寻路），不适合进入与游戏无关的 Core；
- 它们又不是某个业务的私有实现，而是项目为所有业务模块提供的通用能力。

需要为这一类模块确定：放在哪一层、如何被其他模块取得、依赖关系怎样表达。

## 2. 设计输入

- **Core 的边界必须保住**：Core 同级模块之间只依赖契约，Runtime 是唯一组合根，Framework 只消费 Runtime（见 [Core 架构](../design/core/README.md)）。把房间查询、寻路放进 Runtime，会让内核反向依赖游戏概念。
- **这类能力需要生命周期**：订阅事件、维护缓存、按 tick 回收、CPU 准入、错误边界、依赖顺序——这正是 Framework 插件已经提供的东西。任何“绕过插件直接注入上下文”的方案，都要再造一套生命周期驱动。
- **依赖必须显式**：Framework 的停用、熔断、级联释放都建立在“使用者声明了依赖”之上。让所有插件默认拿到所有能力，会让这些机制失去作用对象。
- **服务对象属于提供者的一次激活**：使用时读取，不在 setup 中保存（见 [Framework 使用说明](../usage/core/framework.md)）。任何新方案都不应破坏这条规则。

## 3. 候选方案

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A 维持“插件 + 字符串服务名” | `requires: ['roomShortcuts']` + `services.get<T>('roomShortcuts')` | 生命周期完备、依赖显式；但服务名是字符串，返回类型靠调用方断言，能力的接口与名称分散在各处 |
| B 注入 ModuleContext | 由第二个组合根构建这些能力，挂到 `context.rooms`、`context.move` | 调用最省事；但内核上下文与游戏概念耦合，依赖关系隐形，生命周期要另建一套，与 Framework 重复 |
| **C 服务令牌 + 类型化读取（建议）** | 契约层发布 `ServiceToken<T>`，能力模块发布自己的接口与令牌，`services.get(token)` 直接返回 `T` | 保留插件生命周期与显式依赖，去掉字符串与类型断言；Framework 只需增加一个重载 |
| D 聚合门面 | 所有通用能力打包成一个 `platform` 服务 | 依赖粒度太粗：任一能力重启会牵动全部使用者，熔断与级联的精度下降 |

## 4. 建议方案

### 4.1 分层与目录

```text
contracts/      跨模块协议，不依赖任何实现
core/           与游戏无关的内核能力（Logger、EventBus、MemoryManager、Profiler、ErrorMapper、Framework、Runtime）
capabilities/   与 Screeps 耦合的通用能力（roomShortcuts、goto、房间情报…），每个都是 Framework 插件
modules/        业务模块（经济、防御、扩张…）
app/            组合根：注册插件、决定启停
```

层间规则：

- `capabilities` 只依赖 `contracts` 与注入的 `ModuleContext`，不依赖 `modules`；
- `capabilities` 之间可以互相依赖（例如寻路依赖房间查询），顺序由 Framework 的拓扑排序保证；
- `modules` 通过 `manifest.requires` 加令牌消费 `capabilities`；
- 组合只发生在 `app`。

目录迁移会牵动 `@modules/*` 别名、文档路径与测试导入。可以分两步：先在文档中确立分层与规则，`src/modules/` 暂时同时容纳两类模块；等 goto 落地时一次性迁移目录。

### 4.2 服务令牌

```ts
// contracts/service.ts
declare const SERVICE_TYPE: unique symbol;

/** 服务名与服务类型的绑定；TOKEN 字段只存在于类型层，运行时只有 name。 */
export interface ServiceToken<T> {
  readonly name: string;
  readonly [SERVICE_TYPE]?: T;
}

export const defineService = <T>(name: string): ServiceToken<T> => ({ name });
```

能力模块同时发布接口与令牌：

```ts
// capabilities/roomShortcuts/index.ts
export interface RoomShortcuts {
  getSpawn(roomName: string): StructureSpawn[];
  // …
}
export const RoomShortcutsService = defineService<RoomShortcuts>('roomShortcuts');
```

使用者不再写字符串与断言：

```ts
framework.register({
  manifest: { id: 'defense', version: 1, requires: ['roomShortcuts'] },
  onTickExecute(context) {
    const rooms = context.services.get(RoomShortcutsService); // 类型即 RoomShortcuts
    for (const tower of rooms.getTower('W1N1')) act(tower);
  },
});
```

Framework 侧的改动是给 `services.get` 与 `services.provide` 各加一个接受令牌的重载，运行时仍按 `token.name` 查表，现有字符串写法不受影响。`manifest.provides` 与 `requires` 保持现状：前者是服务名，后者是插件 id，两者语义不同，不合并。

### 4.3 可选依赖的读取

可选依赖目前需要 `try/catch`（提供者不可用时 `get` 抛错）。建议同时补一个 `services.optional(token)`，返回 `T | undefined`，让可选依赖的读取与“使用时读取”的规则自然配合。

## 5. 为什么不选 B

除了打破 Core 的边界，还有两点：

- **依赖会变隐形**。所有插件都拿到全部能力后，`requires` 失去意义，停用与熔断的级联找不到作用对象，排查“谁在用它”只能靠全局搜索。
- **生命周期要重做**。这些能力需要 setup、事件订阅、按 tick 维护与清理；Framework 已经提供了这一整套，另建一套驱动等于把插件模型复制一遍。

## 6. 落地步骤（若采纳）

1. `contracts` 新增 `ServiceToken` 与 `defineService`，Framework 增加令牌重载与 `optional`，补类型用例与运行时用例。
2. roomShortcuts 发布接口与令牌，`app` 改用令牌注册；使用说明同步。
3. 文档确立分层与层间规则：在 [Core 架构](../design/core/README.md) 之外新增一份能力层说明，或并入文档总导航的分层描述。
4. goto 落地时按新分层放置，并评估把 roomShortcuts 一并迁到 `capabilities/`。

## 7. 待决问题

1. 目录是否真的迁移，以及迁移时机（现在，还是等 goto 落地）。层级名称用 `capabilities` 还是别的（`platform`、`services`）。
2. 是否引入 `services.optional`。
3. 跨 tick 任务调度器归属哪一层：它不依赖 Screeps 概念，但服务于业务计算，见[跨 tick 任务框架提案](./cross-tick-tasks.md)。
4. 令牌是否同时用于 `manifest.provides` 的声明（涉及清单字段的类型变化）。
