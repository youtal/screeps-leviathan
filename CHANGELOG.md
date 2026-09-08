# 更新简讯

## 2026-09-08

- 更新项目依赖和 TypeScript、Jest、Rollup 配置，构建不再依赖 `.secret.json`。
- 以项目内构建插件替代过时的 HTML 和 Screeps 上传插件；上传会校验目标、响应和远端模块内容。
- 修复 Profiler 对方法 `this` 的保持和异常后的调用栈清理，并记录 Framework Memory 映射 TODO。
- 完善 EventBus 类型、作用域存储、取消订阅清理、异常隔离和发布前作用域快照。
- RoomShortcuts 改为模块级全局订阅建筑事件，通过房间名和双 ID 校验增量更新缓存。
- RoomShortcuts 统一空结果契约，加入无视野失效、强制刷新和默认 5000 tick 的缓存校验租约。
- 增加 Runtime、Profiler、EventBus、RoomShortcuts 和构建上传行为测试。
