# 全项目审计：能力层迁移后（2026-09-23）

- 代码基线：`fd602cc`（`feat/capability-service-tokens`）；审计开始与代码检查结束时工作区干净。
- 范围：`src/` 的公共契约、Core、能力层、App 与工具；构建、上传、隔离集成测试、两棵依赖树及模块文档。审计是只读检查，没有修改产品代码或上传游戏服务器。
- 方法：对照源码、契约、设计和使用说明逐项复核依赖与故障边界；运行类型、Jest/Node、构建、真实引擎和依赖公告检查。两条调度器异常路径另用临时 Jest 用例复现，用例运行后删除，不纳入项目测试集。

## 结论与优先顺序

没有发现新的 P1/P2。新增 **3 项 P3、2 项 P4**。任务调度器的身份校验与持久记录重试是本轮最值得先处理的实现问题；它们不影响当前 App 唯一装配的 RoomShortcuts，但会影响未来使用跨 tick 任务的模块。A05（RoomShortcuts 建筑事件无生产者）仍是现有业务链的 P2 限制；审计后的决定已将其与 A03、A09 一并列为永久接受的风险，不重复列为新发现。

| 顺序 | 发现 | 建议 |
| --- | --- | --- |
| 1 | J01：任务 id 可绕过跨 global 重启记录 | 在 `submit` 创建实例前统一校验持久化路径段；对非法值直接报错 |
| 2 | J02：记录写入/删除单次失败后丢失待办 | 只在对应操作成功后消费待办，覆盖失败后恢复的注册与清理分支 |
| 3 | J03：包含 NUL 的 owner/id 可形成相同注册键 | 校验两段身份，或改用无歧义的元组键 |
| 4 | J04/J05：文档现状与模块文档缺口 | 更正当前用法与交付状态，并补 App 的设计/使用入口 |

## 实现发现

### J01 · P3：任务 id 与持久化路径的校验不一致

[`submitFor`](../../src/core/taskScheduler/createTaskScheduler.ts) 只拒绝空 id（约第 387 行），而 `persist` 把 id 作为 Memory 路径段写入（约第 562、673 行）。MemoryManager 拒绝 `__proto__`、`prototype`、`constructor` 路径段；写入失败被 `tryWrite` 转为告警，任务仍可继续运行。现有 [`test/taskScheduler.test.ts`](../../test/taskScheduler.test.ts) 的“非法任务 id 只让该记录写入失败”用例（约第 920 行）直接证明 `__proto__` 任务完成而没有记录。由此推断：若这类任务在多次 global reset 后仍会重新提交，三次 reset 的保护无法触发；完整的“非法 id + 连续硬终止 + 连续 reset”尚未在真实引擎中复现。任务 id 由项目模块提供，不是外部匿名输入，因此定为 P3。

### J02 · P3：单次记录操作失败后不再重试

[`persist`](../../src/core/taskScheduler/createTaskScheduler.ts) 在遍历删除待办后无条件 `pendingRemovals.clear()`（约第 634 行）；登记时先移出 `pendingRegistrations`、把条目标为 `none`，之后才调用可能失败的 `tryWrite`（约第 635–675 行）。绑定分区失败发生在这些步骤之前，仍会重试；**访问器已取得后单条路径操作失败**则不会重试。临时 Jest 用例用首次 `commit` 抛错、第二次可成功的 MemoryHost 替身调用两次 `persist`，实际 `commit` 只调用一次。结果可能是存续任务缺失重启记录，或已结束任务留有旧记录。默认 MemoryManager 的常规写盘失败发生在 `end` 并保留脏分区，不等同于本缺陷；这里的触发条件是路径操作自身抛错，因此定为 P3。

### J03 · P3：任务注册键可碰撞

[`registryKey`](../../src/core/taskScheduler/createTaskScheduler.ts) 用 NUL 拼接 owner 与 id（约第 51–52 行），注释假设二者不含 NUL；`bind` 只检查 owner 非空（约第 720 行），`submitFor` 只检查 id 非空。临时 Jest 用例确认 `(owner='a', id='b<NUL>c')` 与 `(owner='a<NUL>b', id='c')` 返回同一个任务句柄，后者可误触前者的实例。正式 Framework 插件 id 受更严格的清单校验，不会含 NUL；但公开的 `TaskHost.bind` 与独立 `Runtime.createContext` 没有同样限制，故在这些入口上仍有跨 owner 混淆风险。

## 文档发现

| 编号 | 级别 | 证据与影响 |
| --- | --- | --- |
| J04 | P4 | [`Framework 使用说明`](../usage/core/framework.md) 首段称 `src/app/modules.ts` 注册插件，实际注册调用在 `src/app/runtime.ts`；[`集成测试说明`](../testing/integration.md) 的“已知边界”仍说 TaskScheduler 跨 global 防护待决，而该功能已交付并在 `leviathan-tasks` 第 4 阶段验证；[`goto 设计`](../design/modules/goto.md) 与[总导航](../README.md)仍把规划路径写为 `src/modules/goto/`，能力层设计则把 goto 定位在 `capabilities/`。会误导后续装配和文档归档。 |
| J05 | P4 | 根规范 §7 要求已交付模块维护对应设计与使用说明；`src/app/` 已交付，但目前没有 `docs/design/app.md` 或 `docs/usage/app.md`，总导航用 Core 架构和根 README 代替。App 是业务插件的装配位置，这一缺口使服务发布、注册时机和配置入口分散。 |

[`Framework 主循环`](../../src/core/framework/createFramework.ts) 的任务驱动注释（约第 636–639 行）还说任务只用常规额度、不会透支 bucket；调度器在 `burstBucket` 水位上方允许使用盈余额度。它属于 J04 的注释同步问题，不另编号。

## 架构、运行成本与覆盖边界

| 维度 | 评价与证据 |
| --- | --- |
| 分层 | Core 同级实现只由 Runtime 组合，Framework 消费完整 Runtime；Memory 只能经 MemoryManager；能力层不直接导入 Core/App/业务实现。三项边界测试与 64 个源码文件摘要检查均通过。RoomShortcuts 由 App 在 Framework 创建后注册，并在插件 `setup` 发布服务，符合现行生命周期。服务令牌只绑定服务名与类型，`manifest.requires` 仍须写提供者插件 id；这一残留耦合已在[能力层设计](../design/capabilities/README.md)说明。 |
| 持久化 | 分区数据经同一 MemoryHost 生命周期提交，异常装载进入安全模式；私服场景覆盖未知 schema、整串容量上限、硬终止后的 heap/存储恢复。任一脏分区验证失败仍会阻断本次整串提交，是[MemoryManager 设计](../design/core/memoryManager.md)已明示的取舍。主文本约 209 万 UTF-16 码元时，本轮私服样本为 clean 0.065 CPU、小分区修改 2.029 CPU、大分区重编码 7.808 CPU；它们是本环境的样本，不能外推到官方服务器。 |
| 业务能力 | 当前 App 仅装配 RoomShortcuts。它订阅建筑建成/摧毁事件，但没有生产者；已消失的对象查询时会被过滤，新建建筑可能直到默认 5000 tick 租约到期后的下一次查询才被收录。该 A05 限制已永久接受，能力层目录迁移与服务令牌不改变其效果。RoomShortcuts 被标为 `critical`，将来出现不依赖它的保活插件时，应重新评估全局 safeMode 影响。 |
| 构建与供应链 | `npm run build` 在不指定 DEST 时只生成 bundle，不上传；产物 `dist/main.js` 为 128,473 字节，source map 为 429,192 字节。`.secret.json` 被忽略，跟踪文件只有占位示例。2026-09-23 的 `npm audit --json` 对根依赖报告 0 项已知漏洞；隔离 runner 为 42 项（critical 1、high 15、moderate 21、low 5），与索引中已接受的 A03 一致。runner 构建上下文白名单及运行期禁网、非 root、只读根等限制仍在。审计报告只是所查询 registry 在检查时已知公告的快照，[npm 文档](https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities/)说明了其覆盖范围；旧 lodash 风险可见[官方 GitHub 公告](https://github.com/advisories/GHSA-p6mc-m468-83gw)。 |
| 测试边界 | 真实引擎四个场景覆盖 Runtime、Memory、global reset 与任务调度，但没有端到端建筑事件生产链，也不覆盖完整 backend/上传接口。永久接受的官方服务器性能基线缺口 A09 不在本轮重提。 |

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过（strict） |
| `npm test` | Jest 14 套件、258 项；构建工具 7、产物 3、隔离边界 3 项 Node 测试通过 |
| `npm run build` | 通过；DEST 未指定，没有上传 |
| `npm run test:integration` | 真实引擎 global-reset、memory、runtime、tasks 共 4 场景通过 |
| `npm audit --json` | 根依赖 0 项已知漏洞，退出码 0 |
| `npm audit --prefix test/integration/runner --json` | 隔离 runner 42 项，因发现公告退出码 1；对应已接受风险 A03 |
| Markdown 相对链接与 `git diff --check` | 报告写入后 340 条链接无断链；差异空白检查通过 |

没有部署到官方服务器，也没有测量官方环境 CPU。临时复现用例运行后已删除，报告保留了触发条件与源码位置，整改时应把对应回归用例纳入正式测试。

## 后续整改状态

J01–J03 已在 `fix/task-scheduler-j01-j03` 分支关闭：任务身份在入口校验，持久记录的读取及路径操作失败会重试，NUL 注册键碰撞被阻止。正式回归用例、验证结果见[当日更新记录](../changelog/2026-09-23.md)。本报告以上发现和源码行号仍指向审计时的 `fd602cc` 基线。
