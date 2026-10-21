# M1 私服部署演练记录（dev 0.1.19）

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-22（操作时刻为 UTC 2026-10-21 15:32） |
| 代码基线 | 上一版本：`cb51f01`（0.1.18）；新版本：`dev` 的 `f42ca52`（0.1.19） |
| 目标 | 本机私服 `http://127.0.0.1:21025`，`.secret.json` 中的 `private` 账户；演练前生效分支 `rh-a`（0.1.16 的构建） |
| 验收标准 | 架构 14.3 M1"部署、分支切换与回滚在私服完成演练"；顺序按 13.3 的私服回归"上一版本 → 新版本 → 回滚到上一版本" |
| 工具 | `npm run deploy`（scripts/deploy）；游戏内状态经控制台 API 执行 `ops.status()` 读取 |

## 1. 步骤与结果

每一步都在部署工具回读校验之后，于游戏内读取 `ops.status()`，以版本号与健康状态确认生效的代码确实在运行。

| 步骤 | 操作 | 部署工具输出 | 游戏内状态 | 结果 |
| --- | --- | --- | --- | --- |
| 1 上一版本 | 检出 `cb51f01`，`upload --account private --branch rh-0.1.18 --activate` | 新建 `rh-0.1.18`，main 与 source map 回读校验通过；生效分支切换为 `rh-0.1.18` | tick 36981：版本 0.1.18，健康 ok，NORMAL/strong，Memory ready | 通过 |
| 2 新版本 | 回到 `dev`（`f42ca52`），`upload --account private --branch rh-0.1.19 --activate` | 新建 `rh-0.1.19`，回读校验通过；生效分支切换为 `rh-0.1.19` | tick 36992：版本 0.1.19，健康 ok，NORMAL/strong，Memory ready | 通过 |
| 3 回滚 | `rollback --account private` | `回滚：rh-0.1.19 → rh-0.1.18`；`branches` 确认 `rh-0.1.18` 生效 | tick 37000：版本 0.1.18，健康 ok，NORMAL/strong，Memory ready | 通过 |
| 4 收尾 | `activate --account private --branch rh-0.1.19` | 生效分支切换为 `rh-0.1.19` | tick 37014：版本 0.1.19，健康 ok；`part.boot.control` 为 `{version: 2, data: {force: null, frozen: false}}` | 通过 |

- 每一步的入口状态都是冷却 0、连续失败 0、连续 degraded 0、连续暂停 0。
- 本机部署历史（`.deploy-history.json`）按顺序记下四次切换：`rh-a → rh-0.1.18`、`rh-0.1.18 → rh-0.1.19`、`rh-0.1.19 → rh-0.1.18`（rollback）、`rh-0.1.18 → rh-0.1.19`。

## 2. 跨版本的持久数据

- 0.1.19 把 `part.boot.control` 升到版本 2（审计 S-08，`{force, frozen}`）。回滚到 0.1.18 后，旧代码只认版本 1，读到版本 2 时按"未知版本"回到初始数据 `{force: null}`，运行正常；再升到 0.1.19 时按版本 1 迁移，补 `frozen: false`。
- 代价：回滚到 0.1.18 会丢失 0.1.19 持久化的冻结状态与尚未采用的人工指定。演练时两者都为空，没有影响；若在冻结期间回滚，冻结要等新版本再次判定时重新得出。

## 3. 验证边界

- 私服账户的模块清单为空，演练只覆盖部署、切换、回滚与 kernel、boot 的运行，不代表业务模块的运营。
- 回读校验比较的是上传的 main 与 source map，没有逐字比较回滚后服务器上的代码；回滚后的版本号由游戏内 `ops.status()` 确认。
- 演练前的 `rh-a` 与 `default` 分支保留未动；演练新建的 `rh-0.1.18`、`rh-0.1.19` 留在私服上，私服最终运行 `rh-0.1.19`（0.1.19）。
- 官服上的上传、切换与回滚另见 [M1 官服验证记录](./2026-10-21-m1-official-validation.md)。
