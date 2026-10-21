# Memory 纯数据边界下的方法复核

- 基线：`feat/kernel-memory` 工作区，HEAD `57f1290`；含尚未提交的 Memory v1、undefined 拒绝及 MD-01 数组原型修正。行号以本轮读取的源码为准。
- 范围：Memory 内部方法在纯 JSON 边界下的必要性、重复工作和注释一致性。
- 挂起列表已读取，无挂起条目。本轮只报告，未修改实现。
- 结论：发现 1 项说明需要澄清、3 项可简化操作；未发现必须因本次数据类型限制而新增业务 API 的需要。不能把输入限制等同于 heap 在任意时刻都合法。

## MS-01 · P3 · has 的 undefined 说明应区分合法数据和暂存状态

**分类：范围内修正；证据：源码确认及运行探针。**

位置：[accessor.ts:38](../../src/kernel/memory/accessor.ts) 的 has 注释、[path.ts:76](../../src/kernel/memory/path.ts) 的 hasAt 注释。当前写着“显式 undefined 字段也算存在”，未说明这种值已经不能作为合法持久数据。

实现使用 hasOwn 本身不应删除：update 可在 commit 前留下显式 undefined，失败后也不回滚。探针确认 `{value: undefined}` 的 hasAt 返回 true，而 validateJson 抛 TypeError。把 has 简化成 `get(...) !== undefined` 会改变此阶段的字段存在语义。

建议只澄清 JSDoc：has 判断自有字段是否存在；显式 undefined 仅可能作为 update 后尚未通过提交校验的非法暂存值存在，不表示该值获准持久化。无运行行为变化。

## MS-02 · P3 · 未消费的 revision 每次写入都读改写

**分类：简化；证据：全仓引用搜索与计数探针。**

位置：[unit.ts:23](../../src/kernel/memory/unit.ts) 的 revision、[unit.ts:58](../../src/kernel/memory/unit.ts) 的 touch，以及 [runtime.ts:233](../../src/kernel/memory/runtime.ts) 的初始化。搜索 src/test 后，仅找到声明、初始化和自增，没有比较、提交或统计消费者。提交依赖 dirty 集合，revision 不参与判定。

计数探针对同一单元调用 touch 10 次，得到 revision 读取 10 次、写入 10 次，而 dirty 集合仅含 1 个单元。移除 revision 可减少每次标脏的一次字段读改写，以及每单元一个 heap 字段；不改变 intent 数量或持久文本。收益随高频写入累积，不声称已测得 Screeps CPU 降幅。

选项：A 保留，继续承担没有当前使用方的运行成本；B 删除字段、初始化及自增，保留 Set 标脏。**建议 B**，不为潜在使用方保留计数。整改时验证重复标脏仍只编码一次、失败重试不受影响。

## MS-03 · P3 · hasAt/deleteAt 为父路径分配临时数组

**分类：简化；证据：源码确认与调用计数。**

位置：[path.ts:83](../../src/kernel/memory/path.ts) 的 hasAt 与 [path.ts:144](../../src/kernel/memory/path.ts) 的 deleteAt。多段路径均调用 `path.slice(0, -1)`，仅为让 getAt 提前一段结束。一次二段 hasAt 和一次二段 deleteAt 的探针实际产生 2 次 slice 调用。

选项：A 保留简洁实现，每次多段调用分配一份数组；B 使用模块内部带结束下标的定位逻辑，复用原路径，保留自有属性、容器类型和完整路径安全校验。**建议 B**。每次多段 has/delete 可少分配一个临时数组，降低热路径垃圾回收压力；路径最长八段，单次收益有限，不据此重写整个路径模块。

同文件 setAt 的 `Number(key)`（114 行）和 deleteAt 的 `String(key)`（150 行）在 checkSegment 已确认类型后属于恒等转换，可随该项去除；需用 TypeScript 收窄或断言表达已验证类型，不能跳过原有段类型检查。此项不需要扩展公共契约。

## MS-04 · P3 · JSON 遍历重复判断数组与对象原型

**分类：简化；证据：源码确认。**

位置：[json.ts:16](../../src/kernel/memory/json.ts) 的 isObject、[json.ts:36](../../src/kernel/memory/json.ts) 与 41 行的 walk。普通对象在进入递归节点时经过多次 Array.isArray 判断；无原型对象在 isObject 中还会连续两次读取同一原型。该路径覆盖复制与脏单元提交校验，次数随数据节点数量增长。

选项：A 保留现有检查；B 在节点入口保存数组分类，并在对象判断中复用一次取得的原型，继续严格校验普通对象/无原型字典及普通数组。**建议 B，优先级低于 MS-02/03**。收益是减少每个节点的重复内建调用；不得为了减少调用而允许数组子类、类实例或自定义原型，也不需要保存跨调用的对象校验缓存。

## 不建议删除的操作

- **保留 commit 的完整脏单元校验**：update 可以原地引入 undefined、循环、数组子类等，入口数据合法不能保证修改后仍合法。仅依赖 JSON.stringify 会再次静默省略、转换或执行 toJSON。
- **保留 set/replace 的复制及迁移前后复制**：前者隔离调用方引用，迁移输入副本保护失败前的旧数据，输出副本隔离回调可能保留的引用；纯数据并不等于不可变数据。
- **保留 hasOwn、危险路径键、属性描述符与循环检测**：普通对象仍有继承链；update 可改变结构；任意输入仍须在边界验证。复制中的 defineProperty 还承担安全处理合法数据键 `__proto__` 的职责，不能直接换成普通赋值。
- **保留加载后的数据校验**：JSON.parse 并不保证有限数字。运行探针确认 `JSON.parse('{"n":1e400}')` 得到 Infinity，随后 validateJson 拒绝；不能只因输入来自 JSON 文本就删除校验。
- **保留平台写入确认与缓存发布顺序**：这些解决跨 tick 持久化失败，与数据是否纯 JSON 无关。
- **不扩展 get/has 为全树校验**：update 允许暂存非法值，commit 是拒绝写回的边界；每次读取重新遍历整单元反而扩大热路径成本。

## 验证与范围

运行 `npm test -- --runInBand test/kernel/memory`，3 个套件、51 项测试通过。另以当前源码 TypeScript 转译结果执行上述计数和行为探针，未修改生产文件。未运行私服 CPU 基准；运行收益依据操作数量、对象分配及实际调用路径，不使用 Node 耗时推算 Screeps CPU。

上述建议均为模块内部调整或说明澄清，无新增 API 或功能项。无源码修改，因此未重复运行全量构建。若采纳，按批准项分别补回归、反向验证并在本报告追加结果。

## MS-01～04 整改与复核（2026-10-19）

用户明确批准“四项全部落地”。本节对应整改后的工作区，前文保留为原审计记录。

| 项目 | 整改结果 | 回归与反向验证 |
| --- | --- | --- |
| MS-01 | 更新 Accessor.has 与 hasAt 的 JSDoc，区分字段存在和持久化合法性，保留 hasOwn 行为 | 回归验证 update 暂存 undefined 时 has 为 true、commit 拒绝，删除字段后可提交。此项只改注释，没有可撤销的行为修复；另将 hasOwn 临时替换成值非 undefined 判断，确认该行为回归失败，随后恢复 |
| MS-02 | 删除 Unit.revision、注册初始化值及 touch 自增；脏集合去重保留 | 10 次 touch 的单元字段写入计数为 0，队列仍仅含 1 个单元；恢复旧自增语句后计数测试失败 |
| MS-03 | 增加内部 getUntil，以结束下标遍历原路径，移除 has/delete 路径切片及已验证键的 Number/String 转换 | 多段 has/delete 的 slice 调用数为 0；单段、数组父节点、缺失及段类型错误行为通过。恢复原 slice 定位后计数测试失败 |
| MS-04 | walk 在每个容器节点仅分类一次、读取原型一次；isObject 复用一次取得的原型 | 四容器样本在 validate/copy 两模式均为 4 次 Array.isArray、4 次 getPrototypeOf；无原型字典的 isObject 仅读取一次原型。恢复重复判断后 3 项计数测试失败；原有数组子类及非法数据回归仍通过 |

新增 [simplification.test.ts](../../test/kernel/memory/simplification.test.ts) 共 7 项测试。每轮反向验证只临时修改相应片段，验证失败后恢复；最终 `npm run check` 通过：10 个套件、152 项测试，类型检查及构建通过。既有提交失败重试和单元编码次数测试也随全量检查通过。新增方法遵循 JSDoc，公共契约和持久化格式未改变。

运行收益仅按字段写入、路径数组分配及内建调用数量确认；未运行真实私服 CPU 基准，不把 Node 测试耗时解释为 Screeps 收益。源码仍在原任务分支工作区，未提交、合并或部署。
