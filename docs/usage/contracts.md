# 公共契约使用说明

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

提供方应显式声明返回接口，例如 `createLogging(...): LoggerFactory`、`createBus(): Bus`。调用方可以在测试中注入结构兼容对象；这不要求继承具体类，也不意味着该对象已经满足时序和持久化语义。

类型分工见 [契约设计](../design/contracts.md)。`LogOptions` 不再是全局类型，使用前必须 `import type`。已有模块出口保留部分类型转导兼容，但新代码应直接引用 contracts。ProfilerMemory、ProfilerContext、RuntimeOptions 等内部装配模型仍从所属模块引用。

## Memory 契约的交付边界

`MemoryAccessor`、`MemoryAccess`、`ApplyMemoryAccessor` 与 `MemoryApplicationOptions` 已可导入进行类型检查，但不存在可申请真实存储的 MemoryManager 工厂，Framework 也没有注入该能力。

未来获得实际 Accessor 后，每 tick 调用 `access()` 并检查 `status`。指定 priority 的模块必须处理 pending：仅跳过依赖 Memory 的行为，其他活动继续。`retryAt` 是建议重试 tick，不是就绪保证。稳定 Accessor 可以跨 tick 保存，ready 句柄和数据引用不能跨 tick 使用。

申请配置为 `version`、`initialize`、`layer`，以及可选的 `priority`、`migrate`、`checkpointInterval`。`migrate` 接收 unknown 旧数据，须自行校验；TypeScript 泛型不能验证历史 JSON。checkpoint 间隔只适用于 checkpoint 层，约定为正整数，默认 100 tick。

`query()` 只提供类型级只读，不冻结对象；`commit()` 回调要求同步，抛错不承诺回滚，返回成功也不表示已落盘。这些语义必须由未来实现和测试落实。
