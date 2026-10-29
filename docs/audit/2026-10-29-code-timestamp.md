# 代码时间戳与模块重新执行的根因修正（fix/code-timestamp，dev 0.1.20）

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-29 |
| 代码基线 | `dev` 的 `ffbd6a9`（0.1.19）；修复提交 `ac58097`（`fix/code-timestamp`），合并后为 0.1.20 |
| 授权范围 | 用户授权：部署工具修正、移除 `stabilizeCodeTimestamp` 与入口注册表（方案 B）、修订架构附录 A 的 F21，并在 pinkpunk 账户内验证 |
| 目标 | pinkpunk，shard0；验证前生效分支 `audit-fix-0.1.18` |

## 1. 问题

0.1.17 与 0.1.18 把官服"每 tick 在同一 global 中重新执行 main"归因为"官服的代码时间戳是 `Date` 对象"，并在入口用全局注册表与改写 `require.timestamp` 规避。同类项目在官服上没有这一现象：Overmind 在 shard3 的部署记录中，`lastGlobalReset`（只在模块执行时写入）在 15 个 tick 内不变。原结论没有解释这一差别。

## 2. 根因（源码核实）

| 环节 | 位置 | 事实 |
| --- | --- | --- |
| 写入 | backend 3.3.0 `lib/game/api/user.js` | `POST /api/user/code` 写入 `timestamp: new Date().getTime()`（毫秒数）；`POST /api/user/clone-branch` 写入 `timestamp: new Date()`（`Date`）；`set-active-branch` 不改时间戳 |
| 读取 | driver 5.3.0 `lib/runtime/data.js` 第 204 行 | 每 tick 从数据库读出 `userCodeTimestamp`，`Date` 每次是新对象 |
| 比较 | engine 4.3.2 `src/game/game.js` 第 504–511 行 | `userCodeTimestamp != require.timestamp` 为真时新建 `require` 与模块缓存，在同一 global 中重新执行 main |
| 触发 | `scripts/deploy/cli.ts`（修复前） | 目标分支不存在时只调用 `cloneBranch`；pinkpunk 上的分支都按版本新建，所以时间戳一直是 `Date` |

私服存储经 RPC 序列化后时间戳为字符串，按值比较，所以私服不复现。覆盖已有 `default` 分支的部署方式（官网编辑器、常见上传插件）写入毫秒数，也不触发。这与全局对象的用法无关：公开 driver 传给引擎的 `globals` 就是 isolate 的 `global`（`lib/runtime/runtime.js` 第 217 行），即用户代码中的 `globalThis`。

官服 backend 未开源，"官服写入方式与公开 backend 一致"属于推断，由第 4 节的官服验证确认其可观测结果。

## 3. 整改

- 部署工具：`planUpload` 返回上传步骤；新建分支时为 `clone` 后接 `upload`，以同样的模块覆盖一次，使时间戳为毫秒数（`scripts/deploy/lib.ts`、`cli.ts`）。
- 入口：移除 `stabilizeCodeTimestamp`、全局注册表 `resolveEntry`/`ENTRY_KEY`、`EntryLoop` 的 `reevaluated` 与 `dispose`、`EntryDeps.notice`；`loop` 由 `createEntry` 直接创建。代码更新而 global 未重置时，入口与 kernel 随模块重新创建，效果与 global reset 相同。
- 构建：`virtual:release` 不再导出构建标识 `build`，app.assembly 移除 `BUILD`。
- 控制台命名空间的 `Symbol.for` 标记保留，用于代码更新时接替上一轮安装的对象。
- 设计文档：架构附录 A 的 F21、内核设计第 6 节"模块重新执行"、console 第 4 节、bootPort 第 6 节。

## 4. 验证

### 4.1 本地

- `npm run check`：类型检查通过；38 个测试套件、527 个测试通过；构建通过。
- 回归测试 `test/scripts/deploy.test.ts` 的 `planUpload`"分支不存在时新建后再覆盖一次"。反向验证：把新建时的步骤改为只有 `clone` 后，该测试失败（1 failed, 34 passed）；恢复后 35 个全部通过。
- `npm run test:scenarios`：7 个场景全部通过。`module-reevaluation` 改为验证一次重新执行：`require.cache.main.loop` 换成新的入口函数，没有"已被占用"错误，之后 `boot.force('FRESH_START')` 到达新 kernel，备份与清空完成。

### 4.2 官服（pinkpunk，shard0）

探测方法：每 tick 经控制台执行一条表达式，把当时的 `require` 存在全局对象上，并与上一 tick 存下的比较（`same`）；同时记录该全局对象首次探测的 tick（`born`，变化即 global reset）与 `require.timestamp` 的类型。控制台表达式在本 tick 的 loop 之后执行，与入口共用同一个全局对象。探测结束后删除探测用的全局属性。

| 步骤 | 生效分支与上传方式 | 时间戳类型 | 观察 tick | `require` 重建 | CPU/tick |
| --- | --- | --- | --- | --- | --- |
| 基线 | `audit-fix-0.1.18`（0.1.18，改写时间戳） | `String` | 78639254–78639258 | 0/4 | 0.31–0.36 |
| 反向验证 | `fix-ts-clone`，只经 `clone-branch` 上传 `ac58097` 的构建 | `Date` | 78639270–78639279 | 10/10，`born` 不变 | 1.21–1.93 |
| 修复 | 同一分支以 `user/code` 覆盖同样的模块 | `Number` | 78639285–78639294 | 0/9（覆盖时发生一次 global reset） | 0.42–0.94 |
| 端到端 | `fix-ts-tool`，修复后的部署工具 `upload --activate` | `Number` | 78639301–78639315 | 0/14 | 0.34–0.70 |

端到端步骤之后 `ops.status()`：健康 ok，模式 NORMAL/strong，版本 0.1.19（合并前的工作区版本号），Memory ready；入口冷却 0、连续失败 0、连续 degraded 0、连续暂停 0。反向验证与修复两步代码相同，只有时间戳的写入方式不同，结果随之切换，确认了第 2 节的因果链。

## 5. 遗留事项

- pinkpunk 当前生效分支为 `fix-ts-tool`（`ac58097` 的工作区构建，版本标签 0.1.19）；`fix-ts-clone` 是部署历史中的回滚目标，`delete` 不能删除它。两者与此前的演练分支一起，在 M2 首次发布前按 M1 审查 5.2 清理。
- 已用 `clone-branch` 新建、此后没有覆盖过的分支（如 `M1`、`m1-validation-0.1.18`、`debug-entry`）时间戳仍为 `Date`；若需要重新启用，先用 `upload` 覆盖一次。
