# MemoryManager 使用说明

[设计](../../design/core/memoryManager.md) · [源码](../../../src/core/memoryManager/) · [契约](../../../src/contracts/memory.ts)

`core/memoryManager` 是项目访问持久化存储的唯一入口。模块按稳定身份申请独立分区，申请同步完成并返回**在本 global 内长期有效**的访问器，之后跨 tick 直接读写。所有分区只存放在主 RawMemory；Runtime 负责组装，Framework 在 tick 边界驱动 `begin/end`。

```ts
import { createFramework } from '@/core/framework';
import { createRuntime } from '@/core/runtime';

const runtime = createRuntime();
const framework = createFramework({ runtime, plugins: [myPlugin] });
export const loop = framework.loop;
```

## 在插件中使用

```ts
import type { MemoryAccessor, MemoryApplicationOptions } from '@/contracts/memory';

interface State {
  lastTick: number;
  jobs: string[];
  rooms: Record<string, { level: number; note?: string }>;
  config?: { enabled: boolean; limit: number };
}

// 声明放在模块级：initialize/migrate 按函数引用判断“是否同一声明”，停用再启用、
// setup 中途失败后重试都会重新调用 setup，内联箭头函数会被判为冲突。
const initialize = (): State => ({ lastTick: 0, jobs: [], rooms: {} });
const stateOptions: MemoryApplicationOptions<State> = { version: 1, initialize };

let state: MemoryAccessor<State>;

const plugin: LeviathanPlugin = {
  manifest: { id: 'logistics', version: 1 },
  setup(context) {
    // 同步返回长期访问器；失败直接抛错，进入本插件的错误边界。
    state = context.memory('main', stateOptions);
  },
  onTickExecute(context) {
    const level = state.get(['rooms', 'W1N1', 'level']);   // 缺失返回 undefined
    state.commit('lastTick', context.tick);                // 顶层键
    state.commit(['rooms', 'W1N1'], { level: 1 });         // 新 Record 条目须提交完整值
    state.commit(['rooms', 'W1N1', 'level'], (level ?? 0) + 1);
    state.commit((memory) => {                             // 回调：任意原地修改
      memory.jobs.splice(8);
    });
    state.remove(['rooms', 'W9N9']);                       // 返回是否删除了目标
  },
};
```

访问器方法：

| 方法 | 结果 | 修改语义 |
| --- | --- | --- |
| `query()` | 整个分区的深只读引用 | — |
| `get(key)` / `get(path)` | 目标的深只读值；中间层或目标缺失返回 `undefined` | — |
| `commit(mutator)` | 回调返回值 | 回调前标脏并要求收尾完整校验；回调抛错不回滚 |
| `commit(key, value)` / `commit(path, value)` | `void` | 预检成功后标脏并写入值的**副本**；预检失败不修改、不标脏 |
| `remove(key)` / `remove(path)` | 是否删除了目标 | 删除成功才标脏；目标不存在返回 `false` |

没有 `access()`、`status()` 或 pending 状态。`commit` 只表示 heap 已接受修改，持久化在本 tick 的 `end` 统一完成。

## 深路径

- 字符串参数是**一个完整顶层键**，不按点号拆分；`'W1N1.spawn'` 这类含点号的键按原样处理。
- 深路径是非空数组：字符串段用于对象键，非负整数段只用于数组下标。可以复用 `as const` 常量：
  ```ts
  const LEVEL = ['rooms', 'W1N1', 'level'] as const;
  state.commit(LEVEL, 2);
  ```
- **写入要求所有中间容器已经存在**：不会自动创建中间对象，也不会扩容数组。可选对象或 Record 条目缺失时，先在父容器上提交完整对象，或在回调中初始化。
- 数组下标必须指向已有元素；数组元素不能通过路径删除（会移位或留下空洞），请在回调中 `splice`。
- `get` 穿越已存在的基本值（如 `['count', 'x']`）或段类型与容器不匹配时抛错；`__proto__`、`prototype`、`constructor` 段一律拒绝；空路径不代表整个分区。

编译期检查：路径与值的类型由 `MemoryAccessor<M>` 推导，错误键、错误值、数组方法名（`length`、`push`）、越界元组下标、宽 `string[]` 路径、对静态必填属性的 `remove`（即使类型同时带有索引签名）都会编译失败。`Record<number, X>` 这类数字键记录用字符串段访问，例如 `['byTick', String(tick)]`：JSON 对象键总是字符串，运行时也只接受字符串段；分区根本身是数字键记录时，顶层键重载同样接受字符串键（`get('100')`）。路径类型最多 8 段（`MaxPathDepth`），更深的修改用 `commit(mutator)`。`MemoryAccessor<any>` 是显式的动态入口：放弃编译期路径检查，运行时校验照常执行。

项目当前未开启 `strictNullChecks`，编译期无法拒绝 `commit(key, undefined)`；运行时会以“undefined is not a JSON value”拒绝。删除请用 `remove`。

## 数据约束与引用所有权

分区根必须是普通对象，成员只能是 JSON 值：`null`、布尔、有限数字、字符串、无空洞的普通数组和普通对象。`undefined`、函数、Symbol 值与 Symbol 键、BigInt、`NaN`/`Infinity`、`Map`/`Set`/`Date`、Game 对象、对象上的访问器属性（getter/setter）以及 `__proto__`/`prototype`/`constructor` 键都会被拒绝。

原型链上的可枚举扩展属性（其它代码向 `Object.prototype` 添加的属性）与 `JSON.stringify` 一样被忽略，不视为分区数据，也不会阻断写盘。

出于性能取舍，以下违规**不会被检出**，按原生 `JSON.stringify` 语义写出：数组元素上的访问器（写出 getter 当时的返回值）、数组上的附加属性（如 `list.meta = …`，被省略）、对象的不可枚举属性（被省略）。它们都需要逐元素或逐键额外检查，大型数值数组上会使校验成本增加约 10 倍。不要以这些形式在分区中存放数据。

校验时机：

- `initialize`/`migrate` 的返回值、同版本恢复的历史数据、路径写入的新值：发布前校验，失败直接抛错；新值引用写入目标的祖先同样拒绝。`initialize`/`migrate` 的返回值与路径写入的新值在校验的同一次遍历中**复制**：调用方保留原对象，之后修改、冻结或复用它（例如同一个模块级常量写入多个分区）都不影响分区。复制使对象值写入比只校验多约 35% 的开销。
- `commit(mutator)` 修改过的分区：本 tick `end` 时完整校验，非法数据阻断整串写盘（见下文）。
- 只经路径写入或 `remove` 修改的分区：`end` 直接编码，不再遍历。

`query()`/`get()` 返回真实对象的类型级只读引用，不克隆、不冻结。**不要通过这些引用直接修改数据**：这样不会标脏，修改可能永远不会落盘，也会绕过收尾校验。路径写入保存副本，因此 `commit('b', get('a'))` 得到与 a 互相独立的 b。只有在 `commit(mutator)` 回调中直接赋值同一对象（如 `m.b = m.a`）才会在分区内形成共享，此时不要让不同分区引用同一对象，也不得成环。**共享关系不会被持久化**：global reset 后各引用位置从文本分别解析，成为互不影响的对象；需要跨 reset 保持一致的数据只存一份，用键引用。字段被替换后，之前保存的嵌套引用会脱离分区，需要最新值时重新 `get`。

## 申请配置

| 配置 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 正整数，表示 payload 版本 |
| `initialize()` | 是 | 确认不存在历史分区时同步调用，返回首次安装的分区对象；返回值在校验后被复制，可以安全地返回模块级常量 |
| `migrate(memory, fromVersion)` | 存在不同版本的历史数据时 | 同步接收与历史记录隔离的副本（`unknown`），自行校验并返回目标版本对象（同样在校验后复制）；升级、降级、旧布局导入的版本 0 都走这里 |

- 已存储版本与 `version` 不同而没有 `migrate`：申请抛错，**绝不**回退到 `initialize` 覆盖历史。
- `migrate`/`initialize` 抛错或返回非法数据：申请抛错，历史记录不变。相同声明的失败在本 global 内缓存，不会每 tick 重跑失败回调；修正声明（新的函数引用或版本）即可重新申请。
- 同版本的历史数据不满足数据约束（例如根是数组）：只拒绝该分区申请；声明新版本并提供 `migrate` 修复。
- 重复申请只有 `version`、`initialize`、`migrate` 完全相同（函数按引用）才返回同一访问器，否则抛 `conflicting declaration`。
- 旧协议字段 `layer`、`checkpointInterval`、`priority` 会被显式拒绝。
- 申请只能在 `begin` 成功之后、`end` 之前（插件的 `setup` 与各钩子中）进行；迟到申请与首次申请规则相同，没有申请窗口。

停用或卸载插件不会删除分区，本 global 未申请的历史分区也原样保留并参与写出。没有分区删除或更名接口。

## 提交

- 所有脏分区在本 tick 的 `end` **统一提交**，没有提交层级、间隔或节流选项；同一分区一个 tick 内的多次修改只编码一次。
- 只重新序列化脏分区，其它分区复用已提交的 JSON 片段；但写盘时仍会拼接并输出完整主文本，成本与主 Memory 总量相关。
- 没有任何修改的 tick 收尾是常数时间：不遍历分区、不序列化、不写 RawMemory。
- 任一分区变化都会重新编码**整个分区**。频繁变化的大数据应按独立修改范围拆成多个分区（`context.memory('jobs', …)`、`context.memory('stats', …)`），避免每 tick 编码大对象。

### 整体写盘阻塞

提交是整串的：**任何一个脏分区校验或编码失败、或主文本超过容量，本轮所有分区都不写盘**，包括其他模块的关键状态。失败时：

- 不推进任何已提交基线，脏状态与 heap 修改全部保留，下一 tick 按最新数据自动重试；
- `getStatus().writeFailure` 给出阶段（`validate`/`encode`/`capacity`/`platform`），分区级错误带 `owner`/`localId`，整串错误不伪造归属；
- 访问器照常可用。修复方式是在下一 tick 用该分区的访问器修正非法值（例如 `commit(['box', 'n'], 0)`）或缩减数据。

停用出问题的插件**不会**解除阻塞（其脏状态仍在）；需要由仍持有访问器的修复逻辑处理，或修复插件后恢复执行。重建 global 会丢弃所有未落盘的 heap 修改，再从上一次有效文本恢复，不是无损修复。

### 提交开销与 CPU 预留

提交在所有插件收尾之后执行，本身不做 CPU 准入判断。私服实测（主 Memory 约 2 MB）：只有小分区变化时约 1.5–2.5 CPU，重新编码大分区约 6–10 CPU，均可能超过 Framework 默认的收尾预留 `reserveCpu`（5）。bucket 耗尽、单 tick 上限回落到常规 limit 时，大分区的提交可能在每个 tick 都被 CPU 硬终止，持久化因此一直无法完成（恢复协议保证不丢失已提交数据，但新修改无法落盘）。持有大分区时应：把频繁变化的数据拆成小分区、避免在同一 tick 修改大分区，并按主 Memory 规模调高 `reserveCpu`。

### 容量

主文本上限为 2 097 152 个 **UTF-16 码元**（`string.length`），包含命名空间结构与其他根字段：普通汉字占 1，`😀` 占 2，不是 UTF-8 字节数。超限整串拒绝，不覆盖有效文本。

## 故障与诊断

```ts
const status = manager.getStatus();
// loaded / loadError / tick
// rawWriteError: 'validate o/a: $.box.n: non-finite number' 之类的文本；成功后为 null
// writeFailure: { stage, tick, message, owner?, localId? } | null
// dirty[]: 待提交分区；structureChanged: 是否有待写出的格式转换
// partitions[]: 全部已存储分区（owner、localId、dataVersion、applied）
// ignoredSegmentPartitions[]: 装载时忽略的旧 Segment 身份
// preservedRootKeys[]: 原样保留的其他根字段
```

应用可通过 `framework.getStatus().memory` 读取 `loadError` 与 `rawWriteError`，无需引用实现。

| 故障 | 行为 | 处置 |
| --- | --- | --- |
| 装载失败（坏 JSON、根不是对象、未知 `schemaVersion`、无法理解的结构） | 首次 `begin` 抛错并锁定本 global；之后每次 `begin` 都报告同一错误，Framework 进入安全模式，不执行插件阶段；**绝不写回** | 暂停执行，备份并修复主 Memory 文本后重建 global |
| 分区申请失败（缺少 migrate、回调抛错、数据不合规） | 申请抛错，进入插件错误边界；历史记录不变，其它分区不受影响 | 修正声明或提供 migrate |
| 整串写入失败 | 见“整体写盘阻塞”；不增加插件失败计数、不触发安全模式 | 修正数据或缩减体积，下一 tick 自动重试 |

运行中通过控制台修改 RawMemory 不会被合并，并可能被下一次写盘覆盖；要接纳外部编辑，先停止业务写入再重建 global。

## 生命周期与恢复

- `begin(tick)`/`end(tick)` 的 `tick` 必须等于真实 tick（平台 `getTick()`；经 Runtime 创建时即 `platform.getGame().time`）；同 tick 重复调用不重复装载或提交，`end` 之后同 tick 不再允许修改；回调执行中调用 `begin/end` 视为重入并拒绝。
- CPU 硬终止或遗漏 `end` 后，下一个真实 tick 的 `begin` 会终结旧阶段、清除旧锁；已发布的访问器、脏数据全部保留并在该 tick 提交，不会补跑或回滚旧回调的部分修改。
- 被中断的 `initialize`/`migrate` 不会发布访问器，下一次申请重试。
- global reset 后只从平台实际保存的文本恢复，未提交的 heap 修改随之丢失。
- 首次装载只解析一次主文本，不重新编码：同版本申请直接使用解析出的对象；历史记录与其他根字段在首次提交时才编码为片段（实测 2 MB、100 个分区：装载约 31 ms，全部申请约 41 ms，首次提交约 15 ms，之后的提交约 1.6 ms）。未申请的历史分区在首次提交前以解析对象驻留 heap。

## 旧格式兼容

首次装载时自动转换，并在本 tick `end` 写出 schemaVersion 2（即使没有业务修改）：

- schemaVersion 1：只导入正式归属为 raw 的分区；Segment 归属的身份被忽略（同身份的残留 Raw 副本一并忽略），首次装载输出一次汇总 `warn`，同名分区再次申请时按首次安装处理。Segment 页不会被读取、激活或清空。
- 没有 `memoryManager` 命名空间时，导入旧 `leviathan.plugins` 的对象数据为 `<pluginId>/main`，版本取 `framework.pluginVersions`，缺失记 0（需要 `migrate`）。原 `leviathan` 字段原样保留。
- 历史 payload 可以是任意 JSON 值，未申请时原样保留；`dataVersion` 0 的记录在转换和 global reset 后都能再次装载。

## 日志

`createMemoryManager({ logging })` 接受注入的 `LoggerFactory`，作用域为 `MemoryManager`。默认等级下正常路径静默；`warn`：整串提交失败（同一原因一次）、忽略的 Segment 身份、导入跳过的旧键；`error`：装载失败（每个 global 一次）；`info`：业务迁移完成、写盘失败后恢复。权威诊断以 `getStatus()` 为准。

## 独立使用（不经 Framework）

```ts
const manager = createMemoryManager({
  logging: createLogging(),
  // 二选一：完整平台端口，或只替换缺省平台的 tick 来源（缺省读取全局 Game.time）
  platform: { readRaw, writeRaw, getTick },
  // getTick: () => myGame.time,
});
manager.begin(Game.time);
const accessor = manager.bind('tool')('main', options);
// …
manager.end(Game.time);
```

经 Runtime 创建时，缺省平台的 tick 来源自动取自 `platform.getGame().time`，与 Framework 调用 `begin/end` 的 tick 同源；`createRuntime({ memoryManager: { platform } })` 可替换整个平台端口（此时 tick 由该端口自己提供）；`createRuntime({}, { memory })` 可注入其它 `MemoryHost`，按模块名绑定到 `ModuleContext.memory`，独立 Runtime 需要调用方自行驱动 `begin/end`。

同一 global 只应装配一个 MemoryManager：多个实例各自持有 heap 片段，会互相覆盖同一命名空间。

**访问边界（AGENTS.md 第 9 节）**：除本模块及其平台适配层外，任何源码都不得访问全局 `Memory` 或 `RawMemory`；`test/memoryBoundary.test.ts` 会扫描 `src/` 自动拦截。
