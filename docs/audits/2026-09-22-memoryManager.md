# MemoryManager 模块审计与整改（2026-09-22）

- 审计基线：`912389a`（分支 `refactor/memory-manager-v2`）
- 范围：`src/contracts/memory.ts`、`src/core/memoryManager/*`，Framework/Runtime 中与本模块直接相接的代码，本模块的测试与文档。其他模块、依赖与部署不在范围内。
- 方法：通读源码并逐项对照[设计](../design/core/memoryManager.md)；用临时测试复现可疑点（已删除）；用 tsc 探测类型边界；统计覆盖率。
- 导航：[审计索引](./README.md) · [使用说明](../usage/core/memoryManager.md)

## 1. 结论

没有 P1。共 1 项 P2、4 项 P3、3 项 P4，全部关闭：M1–M3、M6–M8 修改实现并补回归测试，M4、M5 按决定不修改实现，写入使用说明（M5 同时写入设计）。M3 **部分关闭**：只实现了低成本的检查，其余检查因成本过高不实现，理由和实测数据见 §3。

以下核心协议通读后确认正确：提交顺序（平台接受 → 更新基线 → 清脏）、空闲 tick 的 O(1) 路径、失败时不推进基线、带 tick 归属的生命周期锁与硬终止恢复、兼容转换、发布前校验与祖先引用检查。

## 2. 发现与关闭状态

| 编号 | 级别 | 问题 | 处置 | 回归证据 |
| --- | --- | --- | --- | --- |
| M1 | P2 | `initialize`/`migrate` 的返回值被直接用作工作对象。两个分区共用 `() => DEFAULT` 时，修改一个分区会同时改变另一个分区的 heap 和模块常量，而后者没有标脏，存储与 heap 静默分叉；返回冻结常量时，写入在标脏之后才抛错 | 已修复：校验后用 JSON 往返复制为工作对象，只在申请时执行一次 | `M1: isolates initialize and migrate results…`；撤销修复后该用例失败 |
| M2 | P3 | Framework 以 `getGame().time` 调用 `begin/end`，而默认平台的 `getTick` 固定读取全局 `Game.time`。注入模拟 Game 后每个 `begin` 都抛错，Framework 永久停在安全模式 | 已修复：`MemoryManagerOptions.getTick` 供缺省平台使用；Runtime 注入 `() => getGame().time`，且 `RuntimeOptions.memoryManager` 不再接受单独的 `getTick` | `runtime.test.ts` 的 `derives the memory tick from the shared getGame port`；撤销注入后失败 |
| M3 | P3 | 收尾校验不检查数组元素上的访问器（getter 在提交时被执行，返回值被写出）；数组附加属性、Symbol 键、不可枚举属性被静默丢弃 | **部分修复**：对象与数组上的 Symbol 键在发布前和收尾时都会被拒绝。其余三类不检出，写入设计 §4.3 与使用说明，见 §3 | `M3: rejects symbol-keyed properties…`；撤销检查后失败 |
| M4 | P3 | 提交不做 CPU 准入判断，大分区的提交开销（实测 6–10 CPU）可能超过 Framework 默认预留 `reserveCpu`（5） | 按决定不修改实现；使用说明新增“提交开销与 CPU 预留” | — |
| M5 | P3 | 分区内的共享子对象在 global reset 后被分别解析，reset 前后行为不同 | 按决定不修改实现；使用说明与设计 §4.3 写明“共享关系不随持久化保留” | — |
| M6 | P4 | `Record<number, X>` 无法用路径访问；带字符串索引签名的类型允许 `remove` 静态必填键 | 已修复：数字索引记录接受字符串段；可删性按实参判断，区分显式声明的键与索引签名。修复过程中发现并一并修正：字面量 Record 键（如 `remove(['rooms', 'W1N1'])`）原先被误判为不可删 | `test/types/memoryPath.types.ts` 新增正例与负例；`M6: addresses numeric-keyed records…` |
| M7 | P4 | 若干分支没有测试：结构错误、调用参数错误、在 `initialize` 中重入、在回调中调用 `remove` | 已补测试 | 4 个 `M7:` 用例；`namespace.ts` 行覆盖率 92.8% → 100% |
| M8 | P4 | `src/contracts/runtime.ts` 中 `ModuleContext.memory` 的注释已过时 | 已更正；同时更正 Runtime 使用说明中过时的“启动窗口参数”描述 | — |

## 3. M3 的成本取舍

校验器实测（Node，约 660 KB 对象数据与 5 万元素数值数组；数值为单次 ms）：

| 方案 | 对象密集数据 | 5 万元素数值数组 |
| --- | --- | --- |
| 原校验器 | 5.7 | 0.44 |
| 加 Symbol 键检查（已实施） | 7.2（+25%） | 0.44 |
| 加数组逐元素描述符检查 | 7.7 | 4.7（约 10 倍） |
| 加数组附加属性检查 | 6.7 | 2.3（约 5 倍） |
| 加不可枚举属性检查 | 约 +15% | — |
| `Reflect.ownKeys` 一次性检查全部 | 11.0（约 2 倍） | — |

数组的逐元素检查会让大型数值数组的校验成本增加约 10 倍，与本模块“降低持久化开销”的首要目标冲突。这三类写法都要求刻意使用 `Object.defineProperty`、给数组挂属性，或设置不可枚举属性，属于引用所有权契约下的违规用法，按原生 `JSON.stringify` 语义写出。如果之后决定补齐这些检查，只需要修改 `validate.ts` 的 `forEachChild`。

## 4. 验证

| 项目 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过；检查时间 2.95 s，实例化 28.3 万（新增类型用例约 +4 万） |
| `npm test` | Jest 12 套件 162 项；构建工具 4 项、产物 3 项、隔离边界 3 项，全部通过 |
| `npm run build`（无 `.secret.json`） | 通过 |
| `npm run test:integration` | global-reset、memory、runtime 三个场景在私服（screeps 4.3）通过 |
| 回归有效性 | M1、M2、M3 各自撤销修复后，对应用例失败 |
| 覆盖率（memoryManager） | createMemoryManager 99.6%、namespace 100%、paths 98.5%、validate 100%（行） |
| `git diff --check` | 通过 |

## 5. 残余风险

- M3 未检出的三类写法仍会被按原生语义写出（见 §3）。
- M4 属于运维层面的风险：持有大分区时需要按使用说明拆分分区或调高 `reserveCpu`，模块本身不做预算控制。
- 所有结论都在私服上验证，官方服务器未验证。
