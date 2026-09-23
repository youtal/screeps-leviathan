# 公共契约使用说明

本文描述已发布契约。Memory 长期访问器、深路径与同步装载错误契约见 [目标设计](../design/contracts.md)，尚未交付。

从 `@/contracts` 或对应子文件导入类型，不从业务实现推导公共能力。

```ts
import type { Logger, LeviathanPlugin } from '@/contracts';

export const createConsumer = (log: Logger): LeviathanPlugin => ({
  manifest: { id: 'consumer', version: 1 },
  onTickExecute(context) {
    log.info('tick: ' + context.tick);
  },
});
```

提供方应显式声明返回接口，例如 `createLogging(...): LoggerFactory`、`createBus(logging): Bus`。调用方可以在测试中注入结构兼容对象；这不要求继承具体类，也不意味着该对象已经满足时序和持久化语义。

Framework 的装配入口要求完整 `CoreRuntime`。应用应由 `createRuntime()` 取得它；测试替身也必须同时提供 `getGame`、Logger、EventBus、MemoryHost、Profiler、ErrorMapper、TaskHost 与上下文工厂，不能只拼接 Framework 恰好使用的局部字段。缺少 TaskHost 时，Framework 在激活插件时绑定 `context.tasks` 失败，每个 tick 都会进入 safeMode。

TaskHost 替身须提供 `bind`（返回含 `submit`、`get`、`release` 的调度入口）、`persist`、`drive`、`releaseOwner` 与 `getStatus(): { queued: number; running: number }`。Framework 每个 tick 在 MemoryHost `end` 之前调用一次 `persist(tick)`，非 safeMode 的 tick 在 `end` 之后调用一次 `drive(tick, cpu)`，释放插件时调用 `releaseOwner(pluginId)`。调度语义见 [TaskScheduler 使用说明](./core/taskScheduler.md)。

类型分工见 [契约设计](../design/contracts.md)。`LogOptions` 不再是全局类型，使用前必须 `import type`。已有模块出口保留部分类型转导兼容，但新代码应直接引用 contracts。ProfilerMemory、ProfilerContext、RuntimeOptions 等内部装配模型仍从所属模块引用。

## Memory 契约的交付边界

`MemoryAccessor`（长期访问器：query/get/commit/remove）、深路径类型（`PathValue`、`ValidPath`、`RemovablePath`、`MaxPathDepth` 等）、`ApplyMemoryAccessor`、`MemoryApplicationOptions` 与宿主生命周期端口 `MemoryHost` 均已发布；存储实现、路径规则与故障处理见 [MemoryManager 使用说明](./core/memoryManager.md)。

MemoryHost 实现及测试替身必须提供 `begin`、`end`、`bind` 与 `getStatus(): { loadError: string | null; rawWriteError: string | null }`；无故障时两者为 null，实现可额外返回自己的诊断字段。`begin` 在装载失败时抛错。Framework 只将这两个字段投影到 `FrameworkStatus.memory`，不依赖 MemoryManager 的具体类型。

申请同步完成：成功返回在本 global 内长期有效的访问器，可以跨 tick 保存并直接调用；失败直接抛错，没有 pending 状态。`query`/`get` 返回的引用只读，修改必须经 `commit`/`remove`。

申请配置为 `version`、`initialize` 与可选的 `migrate`；没有提交层级、间隔或存储优先级。`migrate` 接收与历史记录隔离的 unknown 旧数据，须自行校验；TypeScript 泛型不能证明反序列化数据的运行时结构。

`query()` 只提供类型级只读，不冻结对象；`commit()` 回调要求同步，抛错不承诺回滚，返回成功也不表示已落盘。实现与测试覆盖这些语义。
