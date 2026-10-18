# contracts 分支交付审计

## 基线与范围

- 日期：2026-10-19。
- 当前分支：`feat/kernel-contracts`；HEAD：`4a1f74e9e0ce4b22ec6ae8b8a88a4759b1a27f92`。
- 集成基线：dev `a19b1b9295b468c55899a4250d4c11b62e2450c9`，包含最新架构共识与章程保护规则。
- 实际审计对象是工作区中尚未提交的交付物：7 个 `src/contracts/` 文件、`test/boundary/`、`test/contracts/`、`test/platform/`，以及 contracts 设计文档、设计索引和架构文档局部改动。`dev..HEAD` 没有任务提交，HEAD 落后 dev 两个提交。
- 关键未提交文件的 SHA-256 前 12 位：`test/boundary/check.ts` 为 `69142aa04765`，`test/platform/memory.ts` 为 `7eb477b320339`，`test/platform/memory.test.ts` 为 `30ac0c561750`，`docs/design/contracts/README.md` 为 `26cebf525f57`。下文代码行号对应这份工作区快照。
- 审计前已阅读挂起问题列表，目前为空。本轮只追加报告与索引，不修改实现或三个受保护文档，不提交、不合并。

## 结论

**目前不具备合并条件。** 类型检查、现有测试与构建通过，但确认了 4 项 P2 问题：平台测试存在假通过，边界检查对三种合规写法误报。另需整理未提交交付物，并在集成时解决架构文档的两处文本冲突。

本次按 contracts 与测试基础设施的阶段交付评审，不要求其完成整个 M1。7 个生产文件均为类型声明，未发现运行时 npm 依赖、绕过持久化入口或擅自实施候选优化。不能把分支落后 dev 显示的旧文档当成主动删除最新共识。

P2 表示应在本任务合并前修复的正确性或验证缺口；这些问题目前影响开发检查与测试可信度，没有证据表明已造成线上故障。

## 问题

### KC-01 · P2 · 平台测试的回调断言失败被捕获，测试仍通过

**类别：范围内修正。证据：源码确认、Jest 反向实验复现。**

- 来源：[test/platform/memory.ts](../../test/platform/memory.ts#L133) 第 133–138 行，`createMemoryPlatform.tick` 捕获 `run()` 的异常，最终通过 `TickResult.error` 返回。这是模拟用户代码异常的既定行为，本身不应改成无条件抛出。
- 传播与落点：[test/platform/memory.test.ts](../../test/platform/memory.test.ts#L31) 第 31–35 行的损坏 JSON 用例，在回调里断言 `Memory` 为 null，却忽略返回的 `error`。第 69–75 行的 RawMemory 上限用例、第 90–96 行的跨 tick 用例、第 101–113 行的 segment 加载用例、第 125–132 行的参数校验用例有同类问题。
- 违反验证目的：README「验证与发布」要求相应测试提供有效验证；这里断言错误无法使测试失败，无法证明相应平台行为正确。

复现：只在 `/tmp` 的副本中分别作以下单项修改，保留原测试结构，用仓库的 Jest、ts-jest 与测试 tsconfig 执行：

| 临时变异 | 实际结果 |
| --- | --- |
| 第 34 行 `toBeNull()` 改为 `toBe('incorrect expected value')` | 14 项全部通过 |
| 第 74 行 `toThrow('2 MB')` 改为 `toThrow('this message never occurs')` | 14 项全部通过 |
| 第 110 行 `toBe('three')` 改为 `toBe('incorrect segment content')` | 14 项全部通过 |

合计 3 个测试文件、42 项测试全部通过，三个故意错误的断言均未使 Jest 失败；仓库源文件未改动。

**建议**：正常 tick 用例在回调之外检查 `result.error`，或用测试辅助函数把非预期错误重新抛出；预期用户代码异常的用例继续显式验证 `error`。修复后重复以上变异，必须失败。代价是少量测试代码，无 Screeps 运行成本。

### KC-02 · P2 · lib 导入 contracts 类型被误判为越层

**类别：范围内修正。证据：源码确认、虚拟源码调用检查器复现。**

- 来源：[test/boundary/check.ts](../../test/boundary/check.ts#L44) 第 44 行，`ALLOWED.lib = []`。
- 传播与落点：同文件第 155–159 行 `checkSpecifier` 对 `import type` 同样应用这张表，返回 `layer` 违规。
- 文档依据：[contracts 设计](../design/contracts/README.md#1-定位) 第 14 行明确“所有层都可以导入 contracts”。纯类型依赖不引入运行时状态。

最小输入：`contracts/value.ts` 导出 `type Value = number`；`lib/value.ts` 为：

```ts
import type { Value } from '../contracts/value';
export const identity = (x: Value): Value => x;
```

实际输出：`lib 不得导入 contracts（../contracts/value）`。按当前文档编写的纯函数会被边界测试阻断。

**建议**：允许 lib 依赖 contracts，添加合规类型导入用例，并保持 lib 不得导入其他有状态层的负例。无游戏运行成本。

### KC-03 · P2 · 独立 fallback 入口被判为未知层，未接入其专用边界

**类别：范围内修正。证据：源码确认、虚拟源码调用检查器复现。**

- 来源：[test/boundary/check.ts](../../test/boundary/check.ts#L58) 第 58–63 行，`layerOf` 只识别根目录的 `main.ts`；第 140–142 行对未知层直接报错并跳过检查。
- 文档依据：dev 架构 4.2、4.3、5.7 已明确独立 `src/fallback.ts`，允许直接使用游戏 API，禁止导入其他项目模块和读写持久化状态。
- 最小输入：`fallback.ts` 内容为 `export const run = (): void => { Game.cpu.getUsed(); };`。
- 实际输出：`fallback.ts 不在任何已知的层中`。未来按已批准架构交付保底入口时，会被本次建立的边界检查阻断；目前仓库尚无 fallback 实现，不能描述为线上保底故障。

**建议**：为这个明确入口加入专用规则；正常直接 API 调用通过，导入项目模块、访问存储的负例失败。不要把它作为任意依赖均获准的普通入口处理。此项源于最新架构修订的同步需要，无游戏运行成本。

### KC-04 · P2 · 使用 SpawnOptions 类型就被当成写入 memory

**类别：范围内修正。证据：源码确认、虚拟源码调用检查器复现。**

- 来源：[test/boundary/check.ts](../../test/boundary/check.ts#L194) 第 194–197 行，`visit` 只检查第三参数的类型是否具有 `memory` 属性。
- 文档依据：架构 4.2 禁止使用 `spawnCreep` 的 `memory` 选项，没有禁止声明平台的选项类型。
- 触发输入：在 `services/spawnQueue/index.ts` 中调用：

```ts
export const run = (spawn: StructureSpawn): void => {
  const options: SpawnOptions = { directions: [TOP] };
  spawn.spawnCreep([MOVE], 'n', options);
};
```

实际输出：`不得使用 spawnCreep 的 memory 选项`。因为 `SpawnOptions` 声明了可选 `memory` 字段，检查器把类型允许该字段等同于实际提供该字段；合法孵化配置被阻断。

**建议选项**：

1. **建议采用**：识别明确可证的选项构造与赋值，为上述无 memory 情况放行，同时保留实际设置 memory 的负例；对无法证明的动态选项明确诊断边界。
2. 保持保守类型策略，但显式约束调用方使用排除 memory 的选项类型，并在模块设计与诊断中说明。实现较简单，调用方多一项类型约定；目前没有这种文档契约，不能把现有误报解释为已约定行为。

两种方案都只影响检查阶段，不增加游戏每 tick 成本。尚未替用户决定策略或修改公共契约。

## 合并准备事项

1. 修复 KC-01 至 KC-04，并补充相应正反用例；这是本报告的建议，尚未执行整改。
2. 当前任务成果尚未提交。应在保留工作区内容的前提下整理成任务提交，才能由分支合并携带这些文件。
3. 用 `HEAD` 版本作为共同基线，对当前架构文件与 dev 版本执行只输出到 `/tmp` 的 `git merge-file -p`：返回 2，产生两处冲突，分别位于 5.2 的 CPU 准入表/相邻说明和附录 B 的 bucket 阈值行。该检查没有修改工作区或 Git 合并状态。集成时应保留 dev 已批准的维护层预算准入、规划门槛 1500 与预计耗用预检，不能整体用旧架构覆盖。仅合并现有 HEAD 不会带上未提交的契约文件。
4. 整理最终合并结果后重新运行类型、单元/边界测试、构建与差异检查。本次含 `src/` 新增，按 README 的版本规则，在合并提交中执行版本更新与校验；若 dev 仍为 0.1.2，则任务合并版本应为 0.1.3。本轮没有修改版本或执行合并。

## 验证记录与限制

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test -- --runInBand` | 5 个套件、59 项测试通过；受 KC-01 限制，不足以证明所有平台断言生效 |
| `npm run build` | 通过，生成 main.js 与 source map；没有上传 |
| `git diff --check` | 通过；另检查新增文件空白与报告链接 |
| 三种合规虚拟文件交给现有 `checkBoundaries` | 复现 KC-02、KC-03、KC-04 |
| `/tmp` 中三组故意错误断言的 Jest 副本 | 42 项全部通过，复现 KC-01 |
| 架构文档离线三方合并预检 | 两处冲突，仅输出临时文件 |

单元测试运行时出现 `.claude/worktrees/deploy/package.json` 与根 package 的 Jest haste 名称重复警告，测试仍完成并通过；该工作树布局不属于本次新增交付物，未作为新引入缺陷整改。

未运行真实 Screeps 私服场景；仓库尚无对应场景测试命令。阅读了上游 [driver runtime](https://github.com/screeps/driver/blob/master/lib/runtime/runtime.js) 与 [engine game](https://github.com/screeps/engine/blob/master/src/game/game.js) 的相关片段，但这不等于对模拟器注释所称的特定发布版本完成了引擎一致性验证。本报告的平台结论来自本地测试调用链及反向实验，不把替身测试写成真实引擎验证，也不对 Screeps CPU 收益作测量结论。

本次不修改 README.md、AGENTS.md、architecture.md。报告中的架构引用按上述 dev 基线阅读；当前分支里的旧文件尚未同步。

## 整改与复核记录（2026-10-19）

本节独立于以上原审计记录。用户要求根据本报告闭环问题，整改继续在 `feat/kernel-contracts` 的上述未提交交付物上进行，HEAD 未变。本次只修改边界检查、相关测试和本节；保留既有源码与文档改动，不执行提交、合并、版本更新或部署。

本次复核快照的 SHA-256 前 12 位：`test/platform/memory.test.ts` 为 `7355df13e442`，`test/boundary/check.ts` 为 `6a2abf2c07be`，`test/boundary/boundary.test.ts` 为 `c15b0e502831`。下列整改定位对应此快照，原问题定位仍按原审计基线阅读。

### 逐项状态

| 编号 | 状态 | 整改与回归证据 |
| --- | --- | --- |
| KC-01 | 已闭环 | [memory.test.ts 第 13 行](../../test/platform/memory.test.ts#L13) 的 `tickWithoutError` 将正常 tick 返回的非预期异常重新抛给 Jest，全部正常 tick 经此入口运行；第 21 行新增断言传播回归。预期用户代码异常继续显式检查 `result.error`，平台提交错误继续检查同步抛出，未修改平台实现。 |
| KC-02 | 已闭环 | [check.ts 第 46 行](../../test/boundary/check.ts#L46) 允许 lib 依赖 contracts；[boundary.test.ts 第 87 行](../../test/boundary/boundary.test.ts#L87) 验证纯类型导入通过，kernel、world、services、colony、domains、app 六层依赖仍被拒绝。 |
| KC-03 | 已闭环 | [check.ts 第 60 行](../../test/boundary/check.ts#L60) 的 `layerOf` 仅识别根 `fallback.ts`；第 155 行起禁止其项目依赖，包括类型、自导入、重导出及动态导入，原存储检查继续适用。[boundary.test.ts 第 92 行](../../test/boundary/boundary.test.ts#L92) 起验证直接游戏 API 与 main 导入通过、目录伪装及违规导入/存储访问被拒绝。未实施 fallback 业务逻辑。 |
| KC-04 | 待用户选择方案 | 再次用报告的最小输入调用 `checkBoundaries`，仍复现 `SpawnOptions` 类型误报。报告列出的两种方案涉及检查策略取舍，已按 AGENTS.md 第 4 节请求用户选择；尚未修改此规则，也未将其列为无法解决或永久挂起。 |

### 反向验证

以下撤销与变异均只在 `/tmp` 副本执行，工作区保持修复版：

| 编号 | 撤销或变异 | 结果 |
| --- | --- | --- |
| KC-01 | 只撤掉 `tickWithoutError` 的异常重抛，保留新增回归 | 14 项通过、1 项失败，失败项正是新增的断言传播回归；恢复后 15 项全部通过。 |
| KC-01 | 分别重复原报告的损坏 JSON、2 MB 错误消息、segment 内容三种错误断言 | 修复前每组 14 项全部假通过；修复后每组 14 项通过、1 项失败，均命中被变异的测试。 |
| KC-02 | 仅将 `ALLOWED.lib` 恢复为 `[]`，保留新测试 | `--testNamePattern KC-02` 的 1 项测试失败，合法 lib 类型导入重新出现 `layer:1`；恢复后通过。 |
| KC-03 | 仅撤销 fallback 的专用入口及导入检查，保留 KC-02 修复与新测试 | `--testNamePattern KC-03` 的 2 项测试均失败；恢复后边界套件 11 项全部通过。 |

复跑入口为 `npm test -- --runInBand --runTestsByPath test/platform/memory.test.ts`，以及 `npm test -- --runInBand test/boundary/boundary.test.ts --testNamePattern KC-02` / `KC-03`。临时证据保存在 `/tmp/kc01-closure-sc5ineme/` 与 `/tmp/kc02-kc03-regression.gsdhqzob/`；它们是本次运行的本地证据，不作为仓库长期依赖。

### 整体验证与剩余边界

- 按顺序运行 `npm run typecheck`、`npm test -- --runInBand`、`npm run build`：全部通过，5 个套件、63 项测试通过；随后 `git diff --check` 通过。另检查本轮未跟踪文件的增量空白与报告相对链接。
- 验证结论为本地静态检查和平台替身测试，不代表真实引擎或官服验证。未运行私服场景：仓库尚无对应命令，本次也没有改变游戏代码或平台模拟行为。
- KC-04 尚未闭环，不能据本节认定全部问题关闭或已具备合并条件。原报告所列提交整理与架构集成事项仍留待用户明确要求集成时处理。

## 后续整改与最终复核（2026-10-19，KC-04）

用户选择 KC-04 的方案 1 后，完成实际构造与赋值分析。本节为最新复核结果；以上原审计及首轮整改记录保留其当时状态。分支与 HEAD 未变，KC-01 至 KC-04 四项 P2 问题现均已闭环。

最终工作区快照的 SHA-256 前 12 位：`test/boundary/check.ts` 为 `6271166da2f9`，新增 `test/boundary/spawn-options.ts` 为 `417cd24ffbbd`，新增 `test/boundary/spawn-options.test.ts` 为 `99e6d7e826fd`。本节行号对应此快照；首轮记录中的行号仍按首轮快照阅读。

### KC-04 整改结果与检查边界

**类别：范围内修正。证据：源码确认、集成回归、撤销修复的反向验证。**

[check.ts 第 213 行](../../test/boundary/check.ts#L213) 的 `spawnCreep` 分支调用 [spawn-options.ts 第 49 行](../../test/boundary/spawn-options.ts#L49) 的 `classifySpawnOptions`，不再以类型是否声明可选 `memory` 成员判定实际写入：

| 分析结果 | 可证明范围 | 检查行为 |
| --- | --- | --- |
| `absent` | 对象字面量、可证展开、同一语句块内局部变量的初始化及直接赋值，证明没有构造 `memory`；省略选项或传入内建 `undefined` | 放行。原报告中带 `SpawnOptions` 标注、仅含 `directions` 的最小输入不再有违规。 |
| `present` | 对象构造、可证展开或直接属性赋值明确包含 `memory` | 保留“不得使用 spawnCreep 的 memory 选项”诊断。括号、`as`、`satisfies` 等包装不会成为绕过检查的依据。 |
| `unknown` | 参数、函数返回值、动态键、无法证明的展开、别名或传参逃逸、闭包、模块顶层绑定、跨块或复杂控制流 | 报“无法静态确认 spawnCreep 选项未设置 memory”，要求使用可检查的对象构造与直接赋值；不把不确定来源描述为已确认写入。 |

实现只作有限局部分析，不做全程序数据流，也不引入排除 `memory` 的新公共类型契约。模块顶层绑定按共享状态处理；对象展开按展开时的状态判定；调用后的属性写入不反推本次调用已携带该属性。代码位于测试基础设施，不进入游戏构建产物，不增加游戏每 tick 开销。

新增 [spawn-options.test.ts 第 77 行](../../test/boundary/spawn-options.test.ts#L77) 起的 31 项集成回归，覆盖上述三类结果及原有存储所有者、同名普通方法边界。复核中发现对象简写 `{ options }` 的属性符号不能代表被引用的局部值符号，已使用 `getShorthandAssignmentValueSymbol` 识别并补充两项别名/传参回归。原生 `memory` 属性检查保持原行为；涉及属性赋值的测试分别核对调用处诊断，原报告最小正例同时要求完整违规列表为空。

### KC-04 反向验证

仅在 `/tmp/kc04-reverse-sm71w5_j/` 的隔离副本操作，工作区始终保留修复：

| 实验 | 结果 |
| --- | --- |
| 保留最终 31 项回归，仅将 `check.ts` 恢复为首轮整改后、KC-04 修复前的版本 | 21 项失败、10 项通过，退出码 1；失败覆盖原始类型误报、类型断言漏报及动态来源诊断。 |
| 恢复最终检查器与分析辅助文件 | 31 项全部通过，退出码 0。 |
| 仅撤销简写属性值符号识别，保留其余最终修复与全部回归 | `shorthandAlias`、`shorthandEscape` 两项失败，其余 29 项通过，退出码 1。 |

上述主对照的测试文件一致，恢复版本与最终工作区三文件逐字节一致；`summary.json`、各副本的 `result.json` / `output.log`、`snapshot-sha256.json` 保存本次证据。仓库回归入口为 `npm test -- --runInBand --runTestsByPath test/boundary/spawn-options.test.ts`。

### 最终验证与交付边界

- 最终按顺序运行 `npm run typecheck`、`npm test -- --runInBand`、`npm run build`、`git diff --check`，全部通过；共 6 个套件、94 项测试通过。另核对未跟踪新增文件的空白、报告相对链接与本轮差异。
- 四项审计问题已关闭，未增加挂起问题。保留已有源码、设计文档与其他工作区改动；没有提交、合并、修改版本或部署。原报告的合并准备事项仍需在用户要求集成时处理，问题闭环不等于已完成合并。
- 未运行真实私服或官服验证：仓库尚无私服场景命令，且本次仅调整开发期检查与测试。平台替身的引擎一致性验证限制继续适用。
