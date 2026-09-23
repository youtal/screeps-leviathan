# 能力层设计

交付状态：部分交付。`ServiceToken<T>`、`defineService<T>` 与 Framework 的令牌式 `get/provide` 已交付，RoomShortcuts 已发布公共查询接口与令牌；`src/capabilities/` 目录、既有能力模块迁移、`services.optional(token)` 和自动化层间边界测试未交付。目标路径为 `src/capabilities/`；下文目录示例是设计协议。

## 1. 定位与目标

能力层容纳与 Screeps 环境高度耦合（房间、建筑、地形、寻路等）、但不属于任何单一业务模块私有实现的通用能力，例如房间信息查询、寻路与移动协作。这类能力的运行时需求——订阅事件、维护缓存、按 tick 回收、CPU 准入、错误边界、依赖顺序——与 Framework 已经为普通插件提供的生命周期完全一致，能力层的模块因此仍然是 Framework 插件，只是在源码目录上与业务模块（`modules/`）区分开。

能力层不进入 Core：它理解游戏领域概念（房间、建筑、寻路），这与 Core"几乎不涉及具体游戏对象"的定位（见 [Core 架构](../core/README.md) §2）相反，Core 也不会因为一个模块重要、调用频繁或被众多使用者依赖而吸收它。

设计目标：

- 依赖显式：使用者在 `manifest.requires` 声明依赖的能力插件 id，Framework 的停用、熔断、级联释放继续以此为作用对象。
- 接口类型化：能力模块发布的服务通过 `ServiceToken<T>` 取得，返回类型由令牌的类型参数决定，不再依赖调用方在 `services.get<T>(name)` 处手写类型断言。
- 生命周期不重造：服务对象仍然"属于提供者的某次激活"，只能在使用时读取，不在 setup 中保存（见 [Framework 设计](../core/framework.md) §5）；令牌只改变读取方式，不改变这条规则。

## 2. 目标架构

### 2.1 目录与依赖方向

```text
contracts/      跨模块协议，不依赖任何实现
core/           与游戏无关的内核能力
capabilities/   与 Screeps 耦合的通用能力，每个都是 Framework 插件
modules/        业务模块
app/            组合根：注册插件、决定启停
```

- `capabilities` 只依赖 `contracts` 与注入的 `ModuleContext`，不依赖 `modules`。
- `capabilities` 之间可以互相依赖（例如寻路依赖房间查询），顺序由 Framework 的拓扑排序保证。
- `modules` 通过 `manifest.requires` 加令牌消费 `capabilities`。
- 组合只发生在 `app`。

### 2.2 服务令牌

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

`services.get`、`services.provide` 各有一个接受令牌的重载，运行时按 `token.name` 查表，同时保留接受字符串的原有重载（详见 [公共契约设计](../contracts.md)）。令牌式 `provide` 的值类型由令牌固定，错误值不能反向拓宽令牌的类型参数。`manifest.provides` 声明服务名、`requires` 声明插件 id，两者是不同的命名空间，令牌不改变这一点，也不合并两者。

### 2.3 消费方式

```ts
framework.register({
  manifest: { id: 'defense', version: 1, requires: ['roomShortcuts'] },
  onTickExecute(context) {
    const rooms = context.services.get(RoomShortcutsService); // 类型即 RoomShortcuts
    for (const tower of rooms.getTower('W1N1')) act(tower);
  },
});
```

`requires` 里的插件 id 与令牌绑定的服务名分属两个命名空间；上面的例子里两者同名只是约定，不是类型层保证——令牌不携带"由哪个插件提供"这条信息，见 §4 残留耦合。

### 2.4 可选依赖（待决）

可选依赖目前通过字符串读取时需要 `try/catch`（提供者不可用时 `services.get` 抛错）。候选设计是补一个 `services.optional(token)`，返回 `T | undefined`，让可选依赖的读取与"使用时读取"的规则自然配合；是否引入见 §5 待决设计事项。

## 3. 性能考虑

`ServiceToken<T>` 在运行时只是一个 `{ name: string }` 对象字面量，`[SERVICE_TYPE]` 字段只存在于类型层，不参与序列化、不被赋值，编译期擦除后与直接传字符串相比不产生额外的运行时开销；`services.get(token)` 内部与 `services.get(name)` 走同一张按名查表，多出的只是一次属性读取（`token.name`）。

## 4. 风险与残留耦合

- **`requires`/令牌命名空间脱钩**：见 §2.3。写错或漏写 `requires` 里的插件 id 时类型检查不会报警，只会在运行时表现为服务不可用；令牌只保证 `services.get` 的返回类型正确，不保证依赖声明本身正确。
- **目录迁移的影响面**：把现有能力模块移入 `capabilities/` 会牵动 `@modules/*` 别名、文档路径、测试导入与源码注释中的路径；模块文档须按 [根开发规范](../../../AGENTS.md) §7 与源码目录同步移动。

## 5. 待决设计事项

1. 目录是否真的迁移，以及迁移时机（现在，还是等 goto 落地）；层级名称用 `capabilities` 还是别的（`platform`、`services`）。迁移一旦发生，须同步更新模块文档、导航、测试导入和源码注释中的路径。
2. 是否引入 `services.optional`，还是首版只提供必需依赖的令牌读取。
3. 令牌是否同时用于 `manifest.provides` 的声明（目前使用 `RoomShortcutsService.name`，清单字段仍是字符串数组）。
4. `requires`/令牌的残留耦合（§4）是否需要专门弥补，例如让 `defineService` 携带所属插件 id、或提供额外的静态检查。
5. 是否为 `capabilities → modules` 的单向依赖规则补一条自动化边界扫描（参照 [`test/coreDependencyBoundary.test.ts`](../../../test/coreDependencyBoundary.test.ts) 与 [`test/memoryBoundary.test.ts`](../../../test/memoryBoundary.test.ts) 的模式），使其具备和 Core、Memory 边界同等的阻断级别检查。
