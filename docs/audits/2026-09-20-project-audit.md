# 2026-09-20 项目审计（整改后工作区）

[审计索引](./README.md) · [前次审计](./2026-09-20.md) · [整改与复审记录](./2026-09-20-remediation.md)

## 1. 结论与基线

本次发现 **4 项可复现问题：P1 ×1、P2 ×3**。最高风险位于迁移恢复：缺少分阶段 payload 完整性校验时，损坏的 journal 或目标页可导致有效源数据被删除。常规测试和集成场景全绿不能覆盖这类故障组合；在重要持久化业务上线前应先完成 S01–S03。

当前 App 只装配 roomShortcuts，没有持久化业务插件、建筑事件生产者，也没有注入 getHostMemory；因此本报告不把条件触发问题描述为默认装配已发生的数据事故。未交付的 goto 和经营业务不列作缺陷。

- HEAD：`c36e2b95ab9b47d2ee8d844623365aa32d9203aa`。
- 实际基线：HEAD **加上审计开始时已有的未提交 R1/R2/R4 修复及复审文档**。未回滚、未重新实现这些修改。
- 96 个受检源码/测试/构建配置文件的聚合 SHA-256：`1b820c1cff62220de598e31dd58d362eeffc9a165928bb9fc2edd22f4cf724b9`。计算规则、8 个已修改代码文件和环境版本见[结构化证据](./evidence/2026-09-20-project-results.json)。该指纹不包含本次新建审计文档。
- 方法：重点通读 MemoryManager、Framework、Runtime、EventBus、Profiler、Logger、ErrorMapper、RoomShortcuts 的主要实现，检查工具、构建部署、边界测试与集成场景；针对关键失败路径注入故障。并非所有文件逐行穷尽，也不保证不存在其他问题。
- 本次只新增审计报告、复现脚本、结果证据并更新审计导航，不修改业务代码、依赖或部署配置，不上传游戏服务器。

## 2. 验证结果

| 检查 | 结果与边界 |
| --- | --- |
| `npx tsc --noEmit` | 通过 |
| `npm test` | 12 套件 188 项通过；另 9 项构建工具、真实产物、隔离边界测试通过。上传相关测试使用假请求，不是真实部署 |
| `env -u DEST npm run build` | 通过，不上传；真实产物测试另验证无凭据运行 |
| `git diff --check` | 通过 |
| `env -u DEST npm run test:integration` | Docker 内 global-reset、runtime、segments 共 3 场景全部通过。首次沙箱 Docker socket 被拒，获授权后运行成功；临时镜像 tag 由 runner 清理 |
| `npx tsc --noEmit --strict` | 5 条错误：源码 1 条（ErrorMapper Map 首键可为 undefined），测试 4 条；维持 A10 结论 |
| 根依赖 `npm audit --json` | 0 项，包括开发依赖 |
| 隔离 runner 锁文件审计 | 42 项：low 5、moderate 21、high 15、critical 1；仍为 A03 已记录的隔离后残余风险，不能表述为所有依赖无风险 |
| 定向故障复现 | 4 项全部复现，S01 含 2 条独立路径；结果见证据文件 |

运行复现：

```bash
node docs/audits/evidence/2026-09-20-project-reproduction.cjs
```

脚本只使用假平台、假 Game 与仓库 TypeScript 转译器，不读凭据、不联网、不写游戏数据。断言固定的是本基线的**缺陷表现**，不是修复验收条件；问题修复后应替换为正式回归并保留本审计历史证据。

## 3. 新发现

### S01 · P1 · 迁移恢复未验证有效 payload 就删除源副本

**位置：** [namespace.ts:129](../../src/core/memoryManager/namespace.ts#L129)、[createMemoryManager.ts:1200](../../src/core/memoryManager/createMemoryManager.ts#L1200)、[createMemoryManager.ts:1228](../../src/core/memoryManager/createMemoryManager.ts#L1228)。

存在两条已复现路径：

1. 加载合法形状但缺少该分区 staged 项的 `switch` journal，源是含 `{ n: 42 }` 的有效 Segment。validateMigration 只要求 staged 是对象；切回 Raw 时使用 undefined payload，序列化后仅剩 `{ dataVersion: 1 }`。下一 tick cleanup 清空源页，global reset 后分区进入 recovery，原数据已无副本。
2. 通过正常流程产生 Raw→Segment 的 `verify` journal，随后把目标信封 payload 改成 null、保留 owner/generation/dataVersion。verify 与 switch 只核对信封头，接受该目标并删除有效 Raw 源。global reset 后只能读到 null 并进入 recovery。

**触发条件：** journal/目标页被手动改坏、外部工具改写或历史损坏后恢复；不是声称正常引擎会自行随机破坏数据。风险在于恢复程序进一步删除了仍有效的副本。第二条路径中当前 heap 可能仍可读，直到 reset 才暴露，故当 tick ready 不能证明持久副本安全。

**与旧结论关系：** A01 的清理归属核验仍有效；F3 的分区装载校验也有效，但检查发生在源数据删除之后，不能代替迁移切换前校验。S01 是迁移数据完整性缺口，不将 F3 的限定关闭结论直接推翻。

**建议与验收：** 对不同 phase 校验 staged 的必需项、payload 形状、身份与版本一致性；在删除 Raw 源或允许 Segment cleanup 前确认目标副本可恢复。损坏时保留有效源、输出诊断，不从缺值制造新记录。回归需覆盖两种方向、无 resident、跨 reset、verify→switch 间目标被改写，以及写失败后重试；断言有效源未被删除、无损坏值被发布为有效目标。

### S02 · P2 · critical 事件回调失败后仍提交业务意图

**位置：** [createFramework.ts:208](../../src/core/framework/createFramework.ts#L208)、[createFramework.ts:420](../../src/core/framework/createFramework.ts#L420)、[createFramework.ts:496](../../src/core/framework/createFramework.ts#L496)。

事件代理用 invoke 捕获订阅者异常，登记到 failed，但没有立即根据订阅者 critical 属性进入安全模式。外层发布者钩子正常返回，阶段检查只看发布者 invoke 的返回结果；critical 故障到 finally 的健康统计才设置 safeMode，此前其他独立插件的意图已经执行。

**复现顺序：** `critical listener failed` → `business action committed`；最终 `safeMode: true`，failures 正确指向 critical/tickBegin。诊断真实，但阻止动作的时机太晚。

**触发条件：** 同步事件订阅者是 critical 插件，其他插件在钩子中发布事件。默认 App 尚无生产者，不代表协议对未来插件安全。

**建议与验收：** 在统一故障记录处或事件代理处及时传播 critical 失败，并让阶段遍历和 broker 后续提交同时观察该状态；仍执行应有的 end 清理。覆盖事件分别在 setup、begin、execute、commit 中触发的场景，断言故障后的业务动作不执行、普通订阅者故障继续隔离。

### S03 · P2 · 宿主根字段 undefined 被拼成非法主 Memory JSON

**位置：** [namespace.ts:383](../../src/core/memoryManager/namespace.ts#L383)、[namespace.ts:388](../../src/core/memoryManager/namespace.ts#L388)。

根字段序列化器逐键拼接 `JSON.stringify(key) + ':' + JSON.stringify(value)`。当 value 为 undefined 时，值的序列化结果也是 undefined，字符串拼接写出 `"optional":undefined`。函数、Symbol、返回 undefined 的 toJSON 也属于同类边界，当前证据脚本只复现 undefined。

**已复现：** 注入 `getHostMemory: () => ({ optional: undefined, rooms: {} })`，同时创建正常 Raw 分区。writeRaw 收到非法 JSON，rawWriteError 仍为 null；重新创建管理器后出现全局 fault，所有分区都无法正常加载。原生 `JSON.stringify` 对整个对象会省略 optional，而不是写出非法值。

**触发条件：** 启用宿主根对象兼容路径；默认 getHostMemory 返回 undefined，不触发。本问题不是 F2 缓存陈旧，而是根字段片段生成不遵循对象 JSON 序列化语义。

**建议与验收：** 非托管字段按对象序列化规则省略不可表示的值，或在写入前明确拒绝并保留旧存储；不能返回“写入成功”却让下一次加载整体失败。回归覆盖 undefined、函数/Symbol、toJSON 返回 undefined，以及实际抛错的循环引用/BigInt，验证任何失败都不覆盖最后有效 Raw 文本。

### S04 · P2 · 持久化接入示例在停用后重新启用时申请冲突

**位置：** [使用说明的 setup 示例](../usage/core/memoryManager.md#在插件中使用)、[createMemoryManager.ts:552](../../src/core/memoryManager/createMemoryManager.ts#L552)、[createMemoryManager.ts:717](../../src/core/memoryManager/createMemoryManager.ts#L717)。

MemoryManager 的重复申请契约明确要求 initialize/migrate 函数引用相同；Framework 停用后会重新调用 setup，管理器并未释放该身份的分区。使用说明却在 setup 内创建 initialize 箭头函数，每次激活都是新引用。

**复现：** 首次 setup 成功并执行一次业务；disable 后 enable，在第二次 setup 得到 `MemoryManager: conflicting declaration for consumer/main`，业务不再执行。setup 申请成功后又因其他原因抛错并重试时，也存在同类引用不稳定风险。

**定性：** 严格重复声明校验本身符合已写明的契约；缺陷是推荐接入方式与 Framework 再激活生命周期不相容，现有重新启用测试没有接入真实持久化申请。不建议据此直接放松全部声明冲突校验。

**建议与验收：** 优先把示例中的声明/initialize/migrate 提到稳定生命周期，补充“真实 MemoryManager + disable/enable + setup 重试”的组合测试；如要支持同身份热替换或新版声明，需单独设计分区释放/重新声明协议。合格行为是再激活成功、数据延续、没有额外初始化覆盖历史。

## 4. 既有问题与架构结论

| 范围 | 本次结论 |
| --- | --- |
| Memory / Core 边界 | 现有边界测试通过；本轮检查未发现已实现模块新增直接越界。A04 的扫描漏检能力仍存在（如 Memory 别名、动态导入、聚合导入），测试通过不是完整静态证明 |
| Runtime 与 Framework | 组合根和依赖注入边界清楚；意图统一仲裁、复制注册描述、finally 恢复、无凭据构建均保留。S02 是关键失败传播例外 |
| Logger / ErrorMapper / Profiler | 日志按等级短路、错误映射有容量限制、Profiler finally 出栈与业务异常隔离。未新增高优先级缺陷；A10 strict 与 A06 长期标签增长仍应跟踪 |
| RoomShortcuts | 缓存保存 ID、不跨 tick 保留对象，失去视野限频有效；A05 仍无建筑事件生产者，新增建筑可能等租约到期才进入索引；A06 多房间缓存总量仍无回收上限 |
| F1–F8 与 R1–R4 | 最近限定范围内的关闭结论保持；S01/S03 表明未覆盖的迁移/序列化失败路径仍需补齐。R2 的框架诊断、R4 的头部缓存已计入本基线 |
| 文档 A07 | EventBus、RoomShortcuts 使用说明、utils 模块文档缺口仍在；App 注释还把 manifest.version 描述为 Memory schema，与契约不一致。导航已明确缺项，不伪称文档完整 |
| 测试 A08 / 性能 A09 | 本地 Docker 测试有效，但只覆盖现有 3 场景；Segment 场景是平台能力探针，并非管理器完整迁移。无已跟踪 CI 工作流；本次未补长期多房间 CPU/heap 基线 |
| 供应链 A03 | 根依赖已清洁；隔离 runner 的 42 项残余风险未消失。运行期禁网、非 root、只读根、无宿主挂载等控制仍存在；不把隔离等同于漏洞修复，也不盲目按 npm 建议降级 runner |
| 控制台 A11 / 上传 A12 | HTML 信任边界及交互测试问题继续开放；上传请求仍无显式应用超时。表单/帮助未从公共 console 入口开放，未在浏览器做利用验证 |

## 5. 处理顺序与限制

1. 优先处理 S01，迁移在删除源之前必须能证明有有效目标；同时把两个故障样本转为正式测试。
2. 处理 S03 的 JSON 片段语义和 S02 的 critical 故障传播；分别验证跨 reset 和故障后禁止业务提交。
3. 修正 S04 接入示例并补生命周期组合测试，避免业务插件按示例接入后不能恢复。
4. 继续按旧审计推进 A04/A05/A07/A08/A10；没有具体负载数据前不新增未经测量的微优化。

本报告的定向复现运行于 Node 假平台，不代表已在正式 Screeps 服务器验证；Docker 场景也不模拟所有线上限制。本次没有重新测量长期 CPU/heap、检查外部 CI 平台或测试真实上传。以上新增项仅审计并给出验收标准，尚未修复。
