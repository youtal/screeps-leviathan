# 模块设计：ops（运维命令）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/app/ops/`；启停标志的存储与生效在 kernel（本文第 3 节） |
| 架构章节 | 5.1 熔断与 `recover(id)`、5.5 启停、5.8 控制台、13.3 新领域默认暂停 |
| 契约 | [contracts](../contracts/README.md) 第 2 节的 `ModuleManifest`：新增 `startPaused`，变更见本文第 3 节 |
| 成熟度 | 定稿 · M1。11.9 的启动判定命令（`boot.assess`、`boot.force`、`boot.dryRun`）属于 app.boot，在第 6 步交付 |

## 1. 职责

app.ops 以 `ops` 命名空间注册运维命令（[console](../kernel/console.md)），把运维意图转为对 kernel 宿主接口的调用：查看状态、启停模块、恢复熔断、调整日志开关。它不理解业务语义，也不直接读写 Memory。

## 2. 命令

| 命令 | 作用 | 生效 |
| --- | --- | --- |
| `ops.help()` | 列出命令与说明（console 自动提供） | 立即 |
| `ops.status()` | 健康状态、模式、版本号；每个模块的层级、状态（运行、暂停、熔断、初始化失败、依赖暂停）、平滑耗用与连续落选次数；实例只汇总数量与熔断数。kernel 不可用时（抛错重建、冷却期）返回入口状态（第 4 节） | 立即，读取本 tick 主循环结束时的状态 |
| `ops.status(id)` | 一个模块及其实例的明细 | 立即 |
| `ops.pause(id)` / `ops.resume(id)` | 运维暂停或恢复一个模块，覆盖清单默认值 | 下一 tick |
| `ops.unset(id)` | 清除该模块的运维覆盖，恢复清单默认值 | 下一 tick |
| `ops.recover(key)` | 清除进程（模块 id 或完整进程键）的熔断状态与失败计数，保留钩子与上下文，不重新 setup（[内核设计](../kernel/README.md#33-错误边界与熔断)） | 下一 tick 起参与调度 |
| `ops.log(level, on)` | 修改日志根对象的默认开关（`LogRoot.setDefault`） | 立即，只存于 heap |
| `ops.log(level, on, scope)` | 修改一个作用域的覆盖值，`on` 为 `null` 时恢复默认 | 立即，只存于 heap |

- 命令在主循环之后运行（[console](../kernel/console.md#2-平台事实)），所以"下一 tick"是自然结果，不需要另设延迟。
- 初始化失败的模块不能经 `recover` 恢复，命令返回原因：须软重置或新的 global（[内核设计](../kernel/README.md#33-错误边界与熔断)）。
- 日志开关只存于 heap：global reset 后回到 `src/settings.ts` 的默认值，避免运维时临时打开的 debug 日志长期留在线上。

## 3. 启停标志（5.5）

### 3.1 契约变更

在 `ModuleManifest` 上增加：

```ts
interface ModuleManifest {
  // …原有字段
  readonly startPaused?: boolean;               // 没有运维覆盖时是否暂停；默认 false（13.3：新领域以暂停状态上线）
}
```

13.3 的流程对应如下：新领域首次发布时 `startPaused: true`；运维经 `ops.resume(id)` 逐个启用；观察期通过后，在后续版本中去掉 `startPaused`，并经 `ops.unset(id)` 清除不再需要的覆盖。

### 3.2 存储与生效

- **存储**：kernel 自己的分区 `part.kernel.switches`，内容为 `{ [模块 id]: 'pause' | 'run' }`，只记录运维覆盖。没有记录的模块取清单的 `startPaused`。kernel 以保留 owner `kernel` 申请分区，所以清单校验拒绝模块 id `kernel`（[console](../kernel/console.md#4-安装)）。
- **读取**：kernel 在每 tick 准入前读取一次。分区的单元版本与内容由 kernel 管理；记录了不存在的模块 id 时忽略该项并告警一次，不自动删除，避免装配临时缺失模块时丢失运维意图。
- **语义**（5.5）：暂停只跳过钩子，不释放实例、不重新 setup；恢复后从下一 tick 继续。
  - 暂停的模块，连同它的全部实例，以及经 `requires` 依赖它的模块，都不参与准入（[cpu](../kernel/cpu.md#32-准入流程)）。
  - 暂停的模块仍执行 `setup`：setup 只在 global 内执行一次，暂停期间不执行，就无法在恢复时补做而不违反"不重新 setup"。
  - 运维暂停不计入熔断，也不使健康状态变为 degraded：能被暂停的只有非生存层模块（下一条），而健康状态只看生存层。
- **生存层**：生存层模块不能经 `ops.pause` 暂停，命令拒绝并说明原因；Memory 中如有生存层模块的 `pause` 记录（例如手工编辑），kernel 忽略它并告警。生存层承担孵化、tower 与 bootstrap，暂停它们等同于关闭基座；需要停用时应通过发布或回滚完成。
- **Memory 不可用时**：Memory 为 empty 或加载失败时，`pause`、`resume`、`unset` 返回错误结果，不写入；kernel 按清单默认值运行。

## 4. 宿主接口

app.ops 通过 kernel 的宿主接口工作，不导入 kernel 的实现（架构 4.2）。app.assembly 创建 kernel 后，以下列接口创建 app.ops：

```ts
interface KernelOps {
  status(): KernelStatus;                        // 最近一次 tick 结束时的状态快照
  setSwitch(id: ModuleId, value: 'pause' | 'run' | undefined): void;   // undefined 清除覆盖；生存层或未知 id 抛错
  recover(key: string): void;                    // 未知进程或初始化失败时抛错
}

interface Kernel {
  // …原有字段
  readonly ops: KernelOps;
  console(namespace: string): ConsoleRegistry;   // 见 console 设计
}
```

- 日志开关直接使用装配方持有的日志根对象，不经 kernel。
- 软重置或抛错重建后，装配方以新的 kernel 重新创建 app.ops；console 的桩对象机制保证重建期间的调用不会落到旧实例（[console](../kernel/console.md#4-安装)）。
- **kernel 不可用时的状态**：控制台命令在主循环之后求值，而入口在 kernel 抛错的同一个 loop 内就销毁实例，所以持续抛错或冷却期间，命令执行时总是没有实例。这时能回答"正常循环为什么没在运行"的只有入口。
  - 入口向装配方提供一个只读的读取函数 `entryStatus()`，返回冷却剩余 tick、连续失败次数、连续 degraded 与暂停计数，以及最近一次失败的 tick 与说明（内核设计第 6 节）。它是 app 层内部的装配参数，不进入 contracts。
  - app.ops 把 `ops.status` 同时登记为离线命令（[console](../kernel/console.md#4-安装)）：kernel 可用时返回 kernel 状态，kernel 被销毁后由桩对象调用离线处理函数，返回入口状态。
  - 其他命令在 kernel 不可用时仍返回桩结果：正常循环本身的缺陷无法通过暂停业务模块解决，恢复要等 kernel 重新装配。
  - 局限：global reset 后若装配本身持续抛错，`ops` 从未安装，控制台中不存在；这时只能看日志。

## 5. 验证

- 单元测试以假 kernel 驱动 app.ops：每个命令的参数校验与结果文本；生存层暂停被拒绝；Memory 不可用时的错误结果；kernel 销毁后 `ops.status()` 返回入口状态，其他命令返回桩结果。
- kernel 测试：开关在下一 tick 生效；暂停传递到实例与依赖模块；暂停不计熔断、不影响健康；`startPaused` 与覆盖的优先关系；未知 id 与生存层记录被忽略并告警；`recover` 清除熔断但不重新 setup。
