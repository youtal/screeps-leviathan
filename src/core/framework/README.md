# Framework

Framework 将负责项目级主循环、错误映射和运行时基础设施。目前该模块仍在开发中。

## TODO：Memory 映射

后续实现统一的 Memory 映射层，将 `RawMemory` 的 JSON 数据映射到全局堆中的稳定对象。目标包括：

- 控制每 tick 的 JSON 解析和序列化开销；
- 为业务模块提供跨 tick 的 Memory 访问能力；
- 在 tick 切换后同步持久化数据，避免模块继续写入旧的 `Memory` 对象；
- 让 Profiler 等长期存在于 global heap 的模块通过映射层取得稳定引用。

Profiler 当前的 memory accessor 会在创建时保存 `Memory.profiler` 引用。在 Framework Memory 映射完成前，这被记录为已知限制，不在 Profiler 内单独实现临时兼容层。
