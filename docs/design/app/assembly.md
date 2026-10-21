# 模块设计：assembly（装配）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/app/assembly/` |
| 架构章节 | 4.2 显式注入与持久化边界、4.3 使用者设置、5.1 模块清单 |
| 成熟度 | 定稿 · M1。模块清单随 M2 的业务模块加入 |

## 1. 职责

app.assembly 把 kernel 及其服务与游戏环境装配起来，只被 `main.ts` 使用。它读取 `Game`、使用者设置（`src/settings.ts`）与全局 `require`，以参数注入 kernel；RawMemory 经 kernel.memory 的 `createGamePlatform` 与 kernel.segments 的 `createGameSegmentsPlatform` 绑定，InterShardMemory 由 kernel.intershard 在 `globalThis` 上检测，本模块不直接访问持久化存储（4.2）。

装配方是除 `main.ts` 外唯一读取 `src/settings.ts` 的模块（4.3，边界测试检查），其他模块经参数取得设置的值。

## 2. 装配内容

- **模块清单**（5.1）：业务模块从 M2 开始加入。
- **boot 定义**：由 app.boot 的 `createBoot` 创建，注入 Memory 身份、版本号、`bootSettings`、读取世界事实与廉价不变量的函数，以及 `Game.notify`（[boot](./boot.md#9-装配)）。
- **Memory 身份**：命名空间、签名与根 schema，是本项目固定的常量。
- **平台注入**：构建注入的版本号（`virtual:release`，[bootPort](../kernel/bootPort.md) 第 6 节）、segment 平台端口、InterShardMemory 所在的全局对象与控制台目标（均为 `globalThis`）。同一版本号也传给 app.boot，供其更新 `sys.release`。
- **运维命令**：每次装配 kernel 后创建 app.ops 的运维命令，传入日志根对象与入口状态的读取函数（[内核设计](../kernel/README.md#6-入口正常循环与保底循环)）。
- **游戏实现**：`GamePort`、`LogSink` 与 `ErrorMapper`。`LogSink` 按[内核设计](../kernel/README.md#5-日志)第 5 节在 `console.logUnsafe` 与 `console.log` 之间选择；`ErrorMapper` 的收尾预留与 kernel.cpu 共用常量，基数见 [errorMapper](../kernel/errorMapper.md#源码映射)。
- **使用者设置**：日志根对象的各级别默认开关与上色开关取自 `loggerSettings`；Memory 的提交抽查数与实例计时开关分别取自 `memorySettings` 与 `profilerSettings`，默认关闭，私服调试与场景测试时手动开启；启动判定的 `autoClear` 与 `dryRun` 取自 `bootSettings`。
