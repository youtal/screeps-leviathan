# 2026-09-20 审计整改记录

[原审计报告](./2026-09-20.md) · [审计索引](./README.md)

修复分支：`fix/audit-2026-09-20`。原审计的缺陷和数字保持原基线；本记录只描述整改结果，按审计建议的顺序分步提交，每步附回归证据。未上传游戏服务器。

## 1. 状态

| 编号 | 状态 | 提交 | 关闭依据 |
| --- | --- | --- | --- |
| F1 | 已修复 | `124d912` | 按页缓存解析结果；空闲 5 tick 对同一页的 `JSON.parse` 由 10 次降为 0 次（修复前回归用例失败） |
| F2 | 已修复（默认路径） | `124d912` | 无宿主根对象时按键缓存快照根字段片段；5 次写入对保留字段的序列化由 5 次降为 0 次；提供宿主根对象时保持现取，不缓存 |
| F3 | 已修复 | `124d912` | Raw 与 Segment 的 payload 为数字、字符串、数组、null 时均进入 `pending('recovery')`；4+1 个用例修复前失败 |
| F3b | 已修复（整串拒绝） | `124d912` | 序列化文本超过 2 097 152 字符不调用引擎写入，保留 dirty 与带体积的 `writeError` |
| F4 | 已修复（限频） | `a6b0e3b` | 无视野按房间只 `warn` 一次，5 次循环调用仅 1 条日志且无 `error`；`structure:built` 5 个分支补测，语句覆盖 64%→75% |
| F5 | 已修复 | fix(utils) 提交 | 构造时浅拷贝；构造、push、pop、clear 后调用方数组保持不变（修复前用例失败） |
| F6 | 已修复 | fix(utils) 提交 | 替换值改函数形式、键名正则转义；`$&`/`$1`/`$$` 原样输出，`a.b` 不再匹配 `aXb`（修复前用例失败） |
| F7 | 已修复（经批准扩展契约） | fix(logger) 提交 | `Logger.isEnabled(level)`；info 关闭时 EventBus 通知路径不调用 info，开启时仍输出 2 条/订阅者；`isEnabled` 与实际输出一致有测试 |
| F8 | 已修复（经批准） | fix(utils) 提交、fix(logger) 提交 | wrappers 注释已更正；`.vscode/settings.json` 已 `git rm --cached`（本地文件保留）；`MAX_GROUP_EVENTBUS_TTL` 审计已判定不计缺陷 |

## 2. F1–F3b 实现说明

- F1：`refreshObservations` 缓存页文本与解析后的信封，文本逐字相同即复用；只驻留 heap，global reset 后重建一次。
- F2：`createRawStore` 增加快照片段缓存，仅在没有 `external` 时使用；`commitExternal` 覆盖快照时整体清空。传入宿主 Memory 时其可被原地深层修改，引用比较发现不了，因此刻意不缓存，避免旧文本覆盖。审计原建议“对未变化的根字段缓存”在该路径上不安全，未采纳。
- F3：恢复分区时复用 `asPartitionData` 校验 payload 形状，失败给出诊断并进入 recovery，而不是 ready 或永久 loading。迁移读取路径与旧布局导入未改动。
- F3b：主 Memory 写入是整串的，无法部分成功，因此只能整体拒绝并按写入失败路径重试，不能“按分区”拆写。长度按字符数近似引擎 2 MB 上限。

## 3. F4 实现说明

`createGetter` 用按房间的 `visionWarned` 标记限频，标记只在 global 内有效。保留“无视野即失效缓存”的既有契约，未采纳审计中“短暂失去视野保留缓存至租约到期”的可选建议：那会改变缓存语义，需要另行确认。审计 A08 建议的事件分支测试已同批补齐。

## 4. F5–F8 实现说明

- F5 改为拷贝是行为变更：此前调用方可借共享数组观察堆内容，现不再成立；仓库内唯一调用点均为空数组或测试，无依赖。
- F6 的转义同时覆盖键名中的 `{`、`}`。
- 未新增的文档：utils 模块的设计与使用说明缺失属 A07，按 AGENTS.md 只报告，未借整改批量补写。

## 5. F7、F8 收尾

用户批准扩展 Logger 契约与取消 `.vscode/settings.json` 跟踪。`isEnabled` 是新增的必需方法，仓库内的 Logger 替身（profiler、framework、roomShortcuts 测试）已补齐。仅在 EventBus 的逐订阅者通知路径使用；订阅、退订等低频日志保持原样，避免扩大改动面。

## 6. 验证

在分支末端执行：`npx tsc --noEmit`、`npm test`（12 套件 183 项）、`npm run build`（无 `.secret.json`）、`git diff --check` 均通过。每个修复的回归用例都在撤销对应源码修改后确认失败。
