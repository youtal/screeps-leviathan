# 模块设计：console（控制台命令注册与分发）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/kernel/console/` |
| 架构章节 | 5.1 `recover(id)`、5.8 控制台、11.9 启动判定命令 |
| 契约 | [contracts](../contracts/README.md) 第 3 节的 `ModuleContext`：新增 `console`，变更见本文第 3 节 |
| 成熟度 | 定稿 · M1 |

## 1. 职责

kernel.console 把各方注册的命令安装为游戏控制台可调用的全局对象，并为每次调用提供错误隔离。命令的语义由注册方实现：运维命令属于 [app.ops](../app/ops.md)，启动判定命令（11.9）属于 app.boot。

## 2. 平台事实

| 事实 | 处理 |
| --- | --- |
| 每个 tick 先执行 `module.exports.loop()`，再在同一个全局作用域中依次求值控制台表达式，表达式的值作为命令结果输出（engine 4.3.2 `src/game/game.js`） | 命令总是在 kernel 当 tick 的提交之后运行；命令对 Memory 的写入在下一 tick 提交，对进程状态的修改在下一 tick 生效 |
| 控制台表达式与主循环共用全局作用域 | 命令以全局对象的形式安装，例如 `ops.status()`、`boot.assess()` |
| 表达式的耗用计入当 tick 的 CPU | 命令应为轻量操作；耗时的诊断分批进行，或只返回已有的统计 |

## 3. 契约变更

在 `ModuleContext` 上增加：

```ts
interface ConsoleRegistry {
  /** 注册命令 `<命名空间>.<name>(...args)`；返回值转为文本输出。 */
  command(name: string, help: string, fn: (...args: readonly unknown[]) => unknown): void;
  /** 注册可读写的设置 `<命名空间>.<name>`，例如 `boot.dryRun = true`（11.9）。 */
  setting(name: string, help: string, get: () => unknown, set: (value: unknown) => void): void;
}

interface ModuleContext {
  // …原有字段
  readonly console: ConsoleRegistry;            // 命名空间为模块 id
}
```

- 命名空间就是模块 id，所以 boot 注册的 `assess` 在控制台中写作 `boot.assess()`，与 11.9 一致。`BootContext` 继承 `ModuleContext`，同样取得 `console`。
- 实例上下文不提供 `console`：命令名必须取自有限集合，按实例注册会使全局命名空间随实例数增长。需要针对实例的命令，由模块注册一个以实例键为参数的命令。
- 宿主侧（不进入 contracts）：`Kernel.console(namespace)` 为 app 层取得同样的注册器，app.ops 以 `ops` 为命名空间注册。

## 4. 安装

- **时机**：注册即安装。普通模块在 `setup` 中注册，boot 在其 `setup` 中注册，app.ops 在装配时注册。
- **全局对象**：每个命名空间一个普通对象，安装在装配方注入的全局目标上（游戏中为 `globalThis`，测试中为隔离对象，与 [intershard](./intershard.md) 的注入方式相同）。命令是对象上的方法，设置是访问器属性；每个命名空间自动带一个 `help()`，列出命令、设置与说明。
- **日志**：命令异常与注册错误记录在命名空间的日志中：模块与 boot 用其上下文日志，宿主命名空间按名称派生作用域。
- **冲突**：
  - 全局目标上已有同名属性、且不是本模块此前安装的对象时，拒绝安装该命名空间并记录错误，不覆盖游戏或其他代码的全局（如 `Game`、`_`）；
  - 命令与设置名须为小写字母开头的字母数字串（`^[a-z][A-Za-z0-9]*$`），`help` 由本模块提供；同一命名空间内重名或名称非法的命令与设置被拒绝并记录错误；
  - 模块 id `kernel` 与 `ops` 保留给宿主，清单校验拒绝这两个 id（[内核设计](./README.md#31-静态模块排序)的保留名在 `boot`、`core` 之外增加这两个）。
- **销毁与重建**：kernel 实例销毁时，把它安装的每个命名空间替换为桩对象：调用任何命令都返回"kernel 未运行（重建或冷却中）"，读取设置也返回这句话、赋值被忽略，`help()` 照常可用并注明 kernel 未运行。销毁后的注册一律忽略。下一个实例重新注册时覆盖桩对象。这样软重置、抛错重建与冷却期间，控制台调用不会落到旧实例上，也不会因全局缺失而报 `ReferenceError`。
- **离线命令**：宿主侧的注册器（`Kernel.console(namespace)`，供 app 层使用）另有 `offline(name, fn)`，为已注册的命令登记一个离线处理函数。桩对象调用该命令时执行离线处理函数，而不是返回桩结果。离线处理函数不得引用 kernel 实例（实例已销毁），只能读取 kernel 之外、跨实例存在的状态，例如入口的状态（[ops](../app/ops.md#4-宿主接口)）。模块上下文中的 `console` 没有此方法：模块的状态都随实例销毁。

## 5. 调用

- **错误隔离**：每次调用都在 try/catch 中。处理函数抛错时，经命名空间的日志记录映射后的错误，并以 `错误：<消息>` 作为命令结果返回，不让异常传出到游戏控制台。
- **结果**：返回值为字符串时原样输出；`undefined` 输出 `ok`；其他值经 `JSON.stringify` 转为文本，超过 `CONSOLE_RESULT_LIMIT` 个字符时截断并注明。结果是纯文本，不含 HTML（README 的 Logger 规则：富文本运维交互由独立模块提供，M1 不提供）。
- **参数**：处理函数自行校验参数，参数不合法时抛错，由上一条转为错误结果。
- **设置**：读取经 `get`，赋值经 `set`。`set` 抛错时同样记录并忽略本次赋值；赋值表达式本身的结果由引擎输出为所赋的值，所以设置的说明中应写明如何确认生效（例如再次读取）。

## 6. 状态与成本

- heap 中保存每个命名空间的命令表与安装的全局对象，随 kernel 实例存在；销毁时替换为桩对象（第 4 节）。
- 没有每 tick 的固定成本：安装发生在 setup 与装配时，调用只发生在控制台输入时。

## 7. 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `CONSOLE_RESULT_LIMIT` | 4000 字符 | 单次命令结果的长度上限 |

## 8. 接口与用法

```ts
createConsole({ target, logger }): ConsoleHost   // target：全局目标；logger(namespace)：命名空间的日志

interface ConsoleHost {
  registry(namespace: string): HostConsoleRegistry;   // 同一命名空间共用命令表
  dispose(): void;                                    // 换为桩对象，之后的注册一律忽略
}

interface HostConsoleRegistry extends ConsoleRegistry {
  offline(name: string, fn: (...args) => unknown): void;  // 只在宿主侧提供
}
```

- 模块经 `ctx.console` 注册（命名空间为模块 id），例如：

  ```ts
  setup(ctx) {
    ctx.console.command('show', 'show(room)：显示该房间的采集站点', (room) => describe(String(room)));
    return {};
  }
  ```

  控制台中输入 `mining.show('W1N1')`。
- app 层经 `Kernel.console(namespace)` 注册宿主命名空间（例如 `ops`），命名空间不得与模块 id 相同。
- 处理函数自行校验参数，不合法时抛错；返回值按第 5 节转为文本。命令的耗用计入当 tick，应保持轻量。

## 9. 验证

单元测试以隔离的全局目标驱动：注册即安装；`help()` 的内容；命令与设置的调用；处理函数抛错时返回错误结果且记录日志；结果的文本转换与截断；与已有全局及命名空间内重名的冲突处理；保留 id 被清单校验拒绝；实例销毁后命令返回桩结果、登记了离线处理函数的命令调用离线处理函数，重建后恢复。
