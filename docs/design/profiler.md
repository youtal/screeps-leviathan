# Profiler 设计

Profiler 使用函数包装、CPU 起止差值和闭包调用栈统计 totalTime/selfTime/calls。父调用的 selfTime 扣除已被 Profiler 包装的子调用时间；未包装的辅助逻辑仍计入父级自身时间。

包装器在创建时登记唯一 label，在执行时读取开关，保留 this、参数、返回值及原始异常。calls 统计所有取得有效样本并写入成功的调用，包括业务抛错的调用。

观测故障不能改变业务语义：开始取样失败则直接转调原函数；结束时先 pop，再尝试读取 CPU、更新父级 childTime 和写入数据。结束取样或存储错误被隔离，不覆盖业务异常。无法取样的调用不保证统计完整。

Profiler 内部适配器每次操作调用 `getMemory` 定位统计命名空间，并在原地更新前调用 `markMemoryDirty`。Framework 把这两个内部函数连接到持久化管理器的 Profiler 检查点分区，默认从首次标脏起最迟 100 tick 提交。连续采样不会移动截止时间，写回成功后才清除 dirty。它们不属于插件公共 API；插件仍只使用 `context.persistence.query/commit` 访问自己的数据。

独立创建 Profiler 时，调用者可以提供自己的存储适配器；若由独立 Runtime 创建且没有注入适配器，统计只存在于该 Runtime 的 heap，不访问全局 `Memory`。Profiler 自身不读取、解析或序列化 RawMemory。

Framework 在 ErrorBoundary 内执行 Profiler 包装钩子。映射和报告发生在插件计时结束之后，使用独立框架标签。已创建的包装器复用至当前 global 生命周期结束；不得每 tick 以同一 label 重复 wrap。

首版保留现有 report 接口，detailed 参数仍为预留项。Memory schema 中累计值表示 CPU 数量，不是现实世界毫秒。
