# Profiler 设计

交付状态：函数计时、报告与统一 Runtime 装配已交付；MemoryAccessor 持久化接入未交付。

Profiler 使用函数包装、CPU 起止差值和闭包调用栈统计 totalTime/selfTime/calls。父调用的 selfTime 扣除已被 Profiler 包装的子调用时间；未包装的辅助逻辑仍计入父级自身时间。

包装器在创建时登记唯一 label，在执行时读取开关，保留 this、参数、返回值及原始异常。calls 统计所有取得有效样本并写入成功的调用，包括业务抛错的调用。

观测故障不能改变业务语义：开始取样失败则直接转调原函数；结束时先 pop，再尝试读取 CPU、更新父级 childTime 和写入数据。结束取样或存储错误被隔离，不覆盖业务异常。无法取样的调用不保证统计完整。

Profiler 内部适配器每次操作调用 `ProfilerStorage.getMemory` 定位统计命名空间，并在原地更新前调用可选的 `markDirty`。两个行为由同一个存储端口表达，存储归属及提交时机由宿主决定，Profiler 不假定持久化可用。该端口属于 Profiler 的装配配置，不是业务模块的数据访问协议。创建时绑定方法所属对象，保留 this，之后每次访问读取对象中的当前统计表；绑定函数随实例跨 tick 复用，global reset 后重新建立。

独立创建 Profiler 时，调用者可以提供自己的存储适配器；若由独立 Runtime 创建且没有注入适配器，统计只存在于该 Runtime 的 heap，不访问全局 `Memory`。Profiler 自身不读取、解析或序列化 RawMemory。

Framework 在 ErrorBoundary 内执行 Profiler 包装钩子。映射和报告发生在插件计时结束之后，使用独立框架标签。已创建的包装器复用至当前 global 生命周期结束；不得每 tick 以同一 label 重复 wrap。

report 接口的 detailed 参数为扩展预留项。Memory schema 中累计值表示 CPU 数量，不是现实世界毫秒。
