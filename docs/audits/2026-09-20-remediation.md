# 2026-09-20 审计整改记录

[原审计报告](./2026-09-20.md) · [审计索引](./README.md)

修复分支：`fix/audit-2026-09-20`。原审计的缺陷和数字保持原基线；本记录只描述整改结果，按审计建议的顺序分步提交，每步附回归证据。未上传游戏服务器。

## 1. 状态

| 编号 | 状态 | 提交 | 关闭依据 |
| --- | --- | --- | --- |
| F1 | 已修复 | `124d912` | 按页缓存解析结果；空闲 5 tick 对同一页的 `JSON.parse` 由 10 次降为 0 次（修复前回归用例失败） |
| F2 | 已修复（默认路径） | `124d912` | 无宿主根对象时按键缓存快照根字段片段；5 次写入对保留字段的序列化由 5 次降为 0 次；提供宿主根对象时保持现取，不缓存 |
| F3 | 已修复 | `124d912` | Raw 与 Segment 的 payload 为数字、字符串、数组、null 时均进入 `pending('recovery')`；4+1 个用例修复前失败 |
| F3b | 已修复（复审后补齐） | `124d912`、`c36e2b9` | 序列化文本超过 2 097 152 字符不调用引擎写入；复审发现仅宿主根字段超限、无待提交分区时失败静默，已增加管理器级 `getStatus().rawWriteError` 与 warn，并有回归 |
| F4 | 已修复（限频；保留无视野清缓存的既定行为） | `a6b0e3b` | 无视野按房间只 `warn` 一次，5 次循环调用仅 1 条日志且无 `error`；同批为 A08 补测 `structure:built` 增量分支（语句覆盖 64%→75%），**不视为 A08 整体关闭**：getter 与事件发布链路仍未覆盖，且仍无事件发布者（A05） |
| F5 | 已修复 | `d1fa7b2` | 构造时浅拷贝；构造、push、pop、clear 后调用方数组保持不变（修复前用例失败） |
| F6 | 已修复（仅覆盖 F6，不含 A11） | `d1fa7b2` | 替换值改函数形式、键名正则转义；`$&`/`$1`/`$$` 原样输出，`a.b` 不再匹配 `aXb`（修复前用例失败） |
| F7 | 已修复（经批准扩展契约） | `7864c3a` | `Logger.isEnabled(level)`；info 关闭时 EventBus 通知路径不调用 info，开启时仍输出 2 条/订阅者；`isEnabled` 与实际输出一致有测试 |
| F8 | 已修复（经批准） | `d1fa7b2`（注释）、`1b05433`（取消跟踪） | wrappers 注释已更正；`.vscode/settings.json` 已 `git rm --cached`（本地文件保留）；`MAX_GROUP_EVENTBUS_TTL` 审计已判定不计缺陷 |

## 2. F1–F3b 实现说明

- F1：`refreshObservations` 缓存页文本与解析后的信封，文本逐字相同即复用；只驻留 heap，global reset 后重建一次。
- F2：`createRawStore` 增加快照片段缓存，仅在没有 `external` 时使用；`commitExternal` 覆盖快照时整体清空。传入宿主 Memory 时其可被原地深层修改，引用比较发现不了，因此刻意不缓存，避免旧文本覆盖。审计原建议“对未变化的根字段缓存”在该路径上不安全，未采纳。
- F3：恢复分区时复用 `asPartitionData` 校验 payload 形状，失败给出诊断并进入 recovery，而不是 ready 或永久 loading。迁移读取路径与旧布局导入未改动。
- F3b：主 Memory 写入是整串的，无法部分成功，因此只能整体拒绝并按写入失败路径重试，不能“按分区”拆写。长度按字符数近似引擎 2 MB 上限。

## 3. F4 实现说明

`createGetter` 用按房间的 `visionWarned` 标记限频，标记只在 global 内有效。保留“无视野即失效缓存”的既有契约，未采纳审计中“短暂失去视野保留缓存至租约到期”的可选建议：那会改变缓存语义，需要另行确认。为 A08 补充的 `structure:built` 增量分支测试只覆盖该子集，A08 保持开放。

## 4. F5–F8 实现说明

- F5 改为拷贝是行为变更：此前调用方可借共享数组观察堆内容，现不再成立；仓库内唯一调用点均为空数组或测试，无依赖。
- F6 的转义同时覆盖键名中的 `{`、`}`。它只修复替换串与键名的字面量处理；A11（控制台 HTML 内容的信任边界，值仍未做 HTML 转义）不因此关闭。
- 未新增的文档：utils 模块的设计与使用说明缺失属 A07，按 AGENTS.md 只报告，未借整改批量补写。

## 5. F7、F8 收尾

用户批准扩展 Logger 契约与取消 `.vscode/settings.json` 跟踪。`isEnabled` 是新增的必需方法，仓库内的 Logger 替身（profiler、framework、roomShortcuts 测试）已补齐。仅在 EventBus 的逐订阅者通知路径使用；订阅、退订等低频日志保持原样，避免扩大改动面。

## 6. 验证

在分支末端执行：`npx tsc --noEmit`、`npm test`（12 套件 184 项）、`npm run build`（无 `.secret.json`）、`git diff --check` 均通过。每个修复的回归用例都在撤销对应源码修改后确认失败。

## 7. F3b 复审补充

复审（独立复现）指出：主 Memory 写入失败的错误记录与告警只在遍历待提交 Raw 分区时执行；仅宿主根字段达到约 220 万字符、没有待提交分区时，写入被拒绝但无告警且 `fault` 为 null。已修复：`MemoryManagerStatus` 新增 `rawWriteError`（整串写入最近一次失败，成功后清空，不同于阻断申请的 `fault`），并新增管理器级 `warn`（同一原因一次）。回归用例覆盖：无分区超限 → 状态与告警 → 缩小后自动重试并清空。提交见 `git log` 中标题含“rawWriteError”的提交。

## 8. 整改后独立复审

复审基线：分支 `fix/audit-2026-09-20` 末端 `c36e2b9`，未合入 `master`。

### 8.1 关闭有效性验证

用临时测试（已删除，工作区保持干净）逐项复测；`npx tsc --noEmit`、`npm test`（12 套件 184 项，另有构建、产物、隔离 9 项）、`npm run build`（无 `.secret.json`）、`git diff --check` 均通过。未重跑 Docker 集成测试。

| 编号 | 复测结果 |
| --- | --- |
| F1 | 10 个 64 KB 非空页跑 6 tick，`JSON.parse` 共 11 次，约 0.8 ms/tick（修复前约 13 ms/tick）；页内容变化与清空后 `reservedSegments` 仍正确更新，缓存不陈旧 |
| F2 | 默认路径根字段 `creeps`、`rooms` 原样保留；注入宿主 Memory 并原地修改后写出的是最新内容 |
| F3 | payload 为 `null`、`5`、`"str"`、`[1]` 均为 `pending: recovery`，`{}` 为 `ready`；次 tick 仍为 recovery，磁盘原 payload 未被覆盖 |
| F3b | 仅宿主根字段约 220 万字符且无待提交分区时 `rawWriteError` 有值、不写引擎；缩小后自动恢复写入 |
| F4 | 静态核对：无视野按房间只 warn 一次，恢复视野后清除标记；回归随全量测试通过 |
| F5 | 入参 `[5,3,9,1]` 在构造和 `push` 后不变，弹出顺序正确 |
| F6 | `$&`、`$1`、`$$` 原样输出，`a.b` 不匹配 `aXb` |
| F7 | info 关闭时一次 publish 产生 0 条 info 调用，开启时 2 条 |
| F8 | 注释已更正，`.vscode/settings.json` 已取消跟踪 |

结论：F1–F8 关闭有效；A05、A08、A11 保持 §1 所述的开放状态。

### 8.2 复审新增项

| 编号 | 优先级 | 问题 | 建议 |
| --- | --- | --- | --- |
| R1 | P3 | F3 使损坏分区永久停在 `recovery`，没有修复或重置入口。数据得以保全，但插件持续不可用，只能手工改 Memory | 在 `docs/usage/core/memoryManager.md` 写明处置流程；是否提供显式重置接口需另行确认 |
| R2 | P3 | 主 Memory 超限后每 tick 重试，所有 Raw 分区（含 critical）无法持久化，迁移清理也被阻塞；`rawWriteError` 仅见于 `getStatus()` 与一条 warn，Framework 和插件无感知。2 097 152 按字符数计，非 ASCII 内容与引擎口径是否一致未验证 | 将持续写入失败暴露给 Framework 状态或使相关分区进入 pending；核实引擎限制口径 |
| R3 | P4 | `createRoomShortcuts.ts` 中 `delete visionWarned[roomName]` 在每次有视野的调用上执行；对已有属性 `delete` 可能使对象退化为字典模式 | 先判断 `if (visionWarned[roomName])` 再删除 |
| R4 | P4 | `parsedPages` 缓存完整信封，其 `payload` 与分区数据在 heap 中重复（最多约 10 页） | 仅缓存归属、代次、数据版本 |

R1–R4 均未修改代码；按 AGENTS.md §3 只记录，实施需另行确认。

### 8.3 契约说明

`Logger.isEnabled` 为新增必需方法，属经批准的契约扩展，不计入问题。

## 9. 复审新增项评估与处置

本轮在 `c36e2b9` 基础上评估 §8，并保留原复审记录。用户已授权落实合理项；以下状态取代 §8.2 的待评估状态。原 F1–F8 关闭结论在各自限定范围内成立；§8 的临时基准数字属于其原测试环境，不作为线上 CPU 承诺。

| 编号 | 评估与关闭状态 | 处置与证据 |
| --- | --- | --- |
| R1 | 部分表述过强；运维文档缺口成立，已关闭 | recovery 并非全部永久：无数据 Segment 可在修复可见页后重读；Raw 使用加载快照，需修复后重建实例。使用说明新增定位、暂停与备份、一致性修复、重建实例、验证流程；明确 initialize/migrate 不能绕过坏 payload 校验，不新增有损重置 API |
| R2 | 可观察性缺口成立，已关闭；字符口径疑问已澄清 | MemoryHost 发布最小 getStatus 诊断，FrameworkStatus.memory.rawWriteError 投影故障；保持 ready 以便插件 commit 缩减数据，不采纳强制 pending。真实 MemoryManager 与 Framework 联合测试覆盖连续失败、dirty 保留、业务继续、诊断快照隔离、缩减后写入成功并清空错误 |
| R3 | 优化理由不足，不采纳并关闭评估 | 条件判断不能避免已有属性最终被删除；对不存在的属性执行 delete 不等于发生形状退化。Node 24 本地 V8 检查中，重复删除不存在属性仍保留 fast properties，而删除已有非末尾属性时有无 guard 都退化。无游戏运行时基准证明增加一次属性查找更优，保留现实现，不宣称性能缺陷已修复 |
| R4 | 重复对象驻留成立，已优化关闭 | parsedPages 只缓存页文本与 schemaVersion/owner/generation/dataVersion，显式构造头部对象以释放解析出的 payload 引用；不缓存目录归属结论。已有 F1 用例与新增“内容变化→清空→复用”的失效回归通过。文本仍驻留用于相等比较，首次或变化时仍完整解析；未宣称消除全部页内存开销或测得具体 heap 降幅 |

### R2 引擎口径核验

2026-09-20 核对官方 [screeps/driver 的 RawMemory.set](https://github.com/screeps/driver/blob/master/lib/runtime/runtime.js#L101-L108)：比较的是 `value.length > 2 * 1024 * 1024`。因此 2 097 152 的单位是 UTF-16 码元，与项目 string.length 一致；UTF-8 字节计量不适用。新增汉字与 emoji 两个边界用例，确认整串恰好达到上限仍写入，多一个码元即拒写。此结论来自公开 driver 源码与本地回归，未代替目标服务器实测，修改过引擎的私服需单独核验。

整串超限阻止所有 Raw 更新与依赖目录落盘的 cleanup，这是保全旧存储的约束，不以丢弃 critical 以外数据或部分写入解决。运维说明已明确 critical 仅规定提交时机、global reset 可丢失未落盘修改，以及停止增长和缩减数据的恢复方式。

### 验证

针对性验证：MemoryManager 与 Framework 两套件共 108 项通过（新增 4 项：框架故障与恢复、两种非 ASCII 边界、页观察缓存失效）。最终 `npx tsc --noEmit`、`npm test`（12 套件 188 项，另 9 项构建工具/产物/隔离测试）、`env -u DEST npm run build`、`git diff --check` 均通过。未重跑 Docker 集成测试，未上传服务器。

## 10. 项目审计 S01–S04 整改

基线：[项目审计](./2026-09-20-project-audit.md)。§9 的 R1/R2/R4 落实提交为 `e282b08`。四项缺陷先用审计复现脚本确认全部复现，再逐项修复并转为正式回归；每个回归在撤销对应源码修改后确认失败。

| 编号 | 状态 | 提交 | 关闭依据 |
| --- | --- | --- | --- |
| S01 | 已修复 | `8637217` | copy 读取的源 payload、verify/switch 的目标 Segment payload、切回 Raw 时携带的数据必须是键值对象，否则中止搬迁并保留源与诊断。两条复现路径（缺 staged 的 switch journal、目标 payload 被改为 null 的 verify）均不再删除有效源，且跨 reset 后数据仍可读（42 / `{n:0}`） |
| S02 | 已修复 | `3a9c282` | critical 订阅者失败在回调返回时立即置安全模式（commit 阶段同时清空可用集合）。事件从 begin、execute、commit 发布时后续业务动作均不执行；非 critical 订阅者失败仍被隔离 |
| S03 | 已修复 | `8637217` | undefined/函数/Symbol/toJSON 返回 undefined 的宿主根字段按原生语义省略，输出可被重新加载且无 fault；循环引用、BigInt 使写入失败，保留最后有效文本并给出 `rawWriteError`。同批修正：无待写内容时清除过期的 `rawWriteError` |
| S04 | 已修复（示例与测试；未改契约） | `6ebec0a` | 使用说明改为模块级稳定声明并写明禁止在 `setup` 内联；新增真实 MemoryManager + disable/enable + setup 重试组合测试，内联声明的对照版本失败。未放宽重复声明冲突校验 |

说明：
- S01 只校验形状与身份，没有把目标 payload 与暂存内容做深度相等比较；形状合法但内容被改写的目标无法区分，这属于外部工具改写的更宽范畴，未在本轮扩大。
- 审计复现脚本 `docs/audits/evidence/2026-09-20-project-reproduction.cjs` 固定的是修复前的缺陷表现，修复后按其头部说明会断言失败，属预期；作为历史证据保留，正式回归已在测试套件中。
- 项目审计第 5 节后续项（A04/A05/A07/A08/A10 等）未在本轮处理，保持开放。

验证：`npx tsc --noEmit`、`npm test`（12 套件 201 项，另有构建、产物、隔离测试）、`env -u DEST npm run build`、`git diff --check`。未重跑 Docker 集成测试，未上传服务器。
