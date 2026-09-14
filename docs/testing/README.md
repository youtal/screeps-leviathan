# 测试文档

[文档总导航](../README.md) · [项目首页](../../README.md)

- [Screeps 4.3 引擎集成测试](./integration.md)：用正式 Rollup 产物在本地真实引擎中执行可控 tick。

普通 TypeScript 单元测试、构建插件测试和 VM bundle 测试仍由 `npm test` 执行。需要启动
Screeps storage、runner 与 processor 的测试归入本目录，并使用独立命令运行，避免把原生编译和
私服进程启动成本加入日常快速反馈。
