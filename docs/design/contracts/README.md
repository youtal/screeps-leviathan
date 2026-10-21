# contracts：注入接口与跨模块协议

| 项 | 内容 |
| --- | --- |
| 源码 | `src/contracts/` |
| 架构章节 | 4.2 依赖规则、5.1 进程表、5.4 上下文、5.6 boot 特权端口、5.8 可观测性、6.3–6.7 持久化、11.1 启动判定 |
| 成熟度 | 定稿 · M1 |

## 1. 定位

contracts 是各层共同依赖的接口层。kernel 通过上下文向模块注入能力，模块只按这里的接口使用这些能力，不导入 kernel 的实现（4.2）。

- **只放声明**：接口、类型别名，以及无状态的冻结常量（例如 `PENDING` 这类哨兵值）。不放函数实现，不放可变状态。
- **不依赖其他层**：contracts 不导入任何其他层；所有层都可以导入 contracts。
- **按使用方分阶段加入**：接口在其第一个使用方交付时加入，不预先设计。第 7 节列出已确定但尚未加入的接口。

文件按能力划分，文件之间的依赖保持无环：

| 文件 | 内容 | 依赖 |
| --- | --- | --- |
| `log.ts` | `LogLevel`、`LogMessage`、`LogLevelSwitches`、`Logger`、`Measure` | — |
| `cpu.ts` | `Tier`、`CpuBudget` | — |
| `console.ts` | `CommandName`、`ConsoleRegistry` | — |
| `memory.ts` | `Json`、路径类型、`Accessor`、分区与切片的声明、实体空间 | — |
| `mode.ts` | `BootMode`、`Strength`、`BootModeView` | — |
| `context.ts` | `ModuleId`、阶段钩子、实例钩子、`ProcessTable`、`ModuleContext`、`InstanceContext` | console、log、cpu、memory、mode |
| `module.ts` | `ModuleManifest`、`ModuleDefinition` | context、cpu |
| `boot.ts` | 项目标记、`BootPort`、`BootContext`、`BootDefinition` | context、memory、mode |
| `settings.ts` | 各模块的使用者设置类型，命名为 `<模块名>Settings`：`LoggerSettings`、`MemorySettings`（提交抽查数）、`ProfilerSettings`（实例计时）、`BootSettings`（自动清空与 dryRun） | log |

**使用者设置**：`src/settings.ts`（架构 4.3）为每个需要使用者设置的模块导出一个常量 `<模块名>Settings`，类型定义在 `contracts/settings.ts` 的同名接口中；装配方读取后作为参数注入对应模块，模块自身不导入设置文件。新增模块的设置时，两处同时增加。

## 2. 模块定义与阶段钩子

```ts
type ModuleId = string;                       // 小写驼峰，全局唯一，例如 'mining'
type Tier = 'survival' | 'economy' | 'maintenance' | 'planning';

interface ModuleManifest {
  readonly id: ModuleId;
  readonly requires?: readonly ModuleId[];    // 硬依赖：缺失或熔断时本模块一同暂停
  readonly optional?: readonly ModuleId[];    // 软依赖：只影响拓扑排序
  readonly tier: Tier;
  readonly priority: number;                  // 同层内的顺序，越小越先
  readonly startPaused?: boolean;             // 没有运维覆盖时是否暂停，默认 false（5.5、13.3）
}

interface PhaseHooks {
  sense?(): void;
  plan?(): void;
  arbitrate?(): void;
  act?(): void;
  move?(): void;
}

interface InstanceHooks extends PhaseHooks {
  dispose?(): void;                           // 实例退役或软重置时调用
}

interface ModuleDefinition extends ModuleManifest {
  setup(ctx: ModuleContext): PhaseHooks;      // 每个 global 调用一次
}
```

- **阶段**：kernel 按 4.4 的流水线依次调用 `sense → plan → arbitrate → act → move`。boot 阶段只运行启动判定（第 6 节），commit 阶段由 kernel 自己执行。
- **钩子不带参数**：上下文在 `setup` 时由闭包持有，每 tick 调用钩子不分配参数对象。
- **错误边界**：每次钩子调用各自隔离，抛错计入该进程的连续失败次数，达到阈值即熔断（5.1）。
- **清单在构建期确定**：app.assembly 把全部 `ModuleDefinition` 交给 kernel，kernel 在每个 global 启动时做一次稳定拓扑排序。依赖环和未知依赖在启动时报错，并拒绝启动该模块及依赖它的模块。
- **保留 id**：`boot`、`core`、`kernel`、`ops` 不能用作模块 id。前两个是启动判定上下文与实体公共切片的 owner，`kernel` 是 kernel 自身分区（启停标志）的 owner，`ops` 是运维命令的控制台命名空间；模块 id 同时是控制台命名空间（第 3 节）。
- **默认暂停**：`startPaused` 为 true 的模块在没有运维覆盖时暂停：仍执行 `setup`，但不运行钩子；运维经 `ops.resume(id)` 启用（[ops](../app/ops.md#3-启停标志55)）。生存层模块不能暂停，此项对其无效。

### 动态实例

```ts
interface ProcessTable {
  add(key: string, create: (ctx: InstanceContext) => InstanceHooks): void; // 已存在则忽略
  remove(key: string): void;                  // 调用实例的 dispose
  has(key: string): boolean;
}
```

- 模块在自己掌握的集合发生变化时显式增删实例，例如发现新 source、殖民地退役。kernel 不在每 tick 轮询实例清单。
- 进程键为 `<模块 ID>:<实例键>`，由 kernel 拼接；实例键由模块从稳定事实派生，例如 `W1N1:<sourceId>`。global reset 后由模块在 `setup` 中重新添加。
- 实例继承所属模块的层级和优先级，在桶内按优先级排列；同一模块的实例按添加顺序排列。
- 模块与实例各自准入（[cpu](../kernel/cpu.md#31-准入单位)）。维护层的模块与实例按各自的进程键错峰，实例运行的 tick 模块自身的钩子不一定运行；实例不能依赖模块钩子在同一 tick 准备的数据。

## 3. 上下文

```ts
interface ModuleContext {
  readonly id: ModuleId;
  readonly log: Logger;
  readonly measure: Measure;
  readonly cpu: CpuBudget;
  readonly memory: PartitionFactory;
  readonly rooms: EntitySpace;
  readonly creeps: EntitySpace;
  readonly flags: EntitySpace;
  readonly mode: BootModeView;
  readonly processes: ProcessTable;
  readonly console: ConsoleRegistry;          // 命名空间为模块 id
  instance(key: string): InstanceContext;
  onDispose(fn: () => void): void;            // 软重置时调用
}

interface InstanceContext {
  readonly key: string;                       // 完整进程键
  readonly log: Logger;                       // 作用域为进程键
  readonly measure: Measure;                  // 计时按进程键聚合
  readonly cpu: CpuBudget;                    // CPU 计入该实例
}
```

- 与 5.4 相比，增加了 `processes`，用于增删动态实例，以及 `console`，用于注册控制台命令；`segments` 与 `services` 随第一个使用方加入（第 7 节）。

```ts
interface ConsoleRegistry {
  command(name: string, help: string, fn: (...args: readonly unknown[]) => unknown): void;
  setting(name: string, help: string, get: () => unknown, set: (value: unknown) => void): void;
}
```

- **控制台**：注册即安装为全局对象 `<模块 id>.<名称>`，例如 boot 的 `boot.assess()`、`boot.dryRun`（11.9）。命令在主循环之后运行，对 Memory 的写入在下一 tick 提交；处理函数抛错时控制台输出 `错误：<消息>`。命令名取自有限集合；实例上下文不提供 `console`，针对实例的命令以实例键为参数。安装、冲突与 kernel 重建时的行为见 [console](../kernel/console.md)。
- 上下文对象在整个 global 生命周期内稳定，`instance(key)` 惰性创建并缓存。实例的持久数据放在所属模块的分区或切片中，按实例键区分（6.4），所以 `InstanceContext` 不带存储接口。

## 4. 日志、计时与 CPU

```ts
type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';
type LogMessage = string | (() => string);       // 函数形式只在该级别开启时求值

interface Logger {
  debug(message: LogMessage): void;
  info(message: LogMessage): void;
  success(message: LogMessage): void;             // 游戏内关键状态转移成功：RCL 升级、订单创建或成交、殖民地扩张等
  warn(message: LogMessage): void;
  error(message: LogMessage, error?: unknown): void; // error 经 errorMapper 映射源码位置
  configLevel(levels: Partial<Record<LogLevel, boolean | undefined>>): void; // 一次覆盖一个或多个级别；undefined 恢复默认
  enabled(level: LogLevel): boolean;
}

interface Measure {
  begin(): number;                            // 返回开始时的 CPU 读数
  end(op: string, start: number): void;       // 标签为 '<作用域>.<op>'；op 必须取自有限集合
}

interface CpuBudget {
  readonly tier: Tier;
  remaining(): number;                        // 本进程本 tick 剩余可用 CPU
  shouldYield(): boolean;                     // 长计算每批检查一次，为 true 时保存游标并返回
}
```

- **日志的双层开关**：每个级别的实际开关取本作用域的覆盖值，其次所属模块作用域的覆盖值（实例作用域继承模块），都没有时取日志根对象的默认值。默认值由装配方在初始化时为每个级别给出。覆盖只存于 heap，模块在 setup 中按需设置。
- 计时采用 `begin` / `end` 两次调用，不使用 `measure(op, fn)` 形式，避免热路径每次创建闭包。

## 5. 持久化

### 5.1 值与路径

```ts
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json | undefined };

type Path<T> = /* 由 T 推导的合法路径元组，1–8 段：对象键为字符串段，数组下标为数字段 */;
type ValueAt<T, P extends Path<T>> = /* 路径指向的值类型 */;
type DeepReadonly<T> = /* 递归只读 */;
```

路径与值的类型由数据类型推导（6.3）。路径以数组传递；热路径上把路径声明为模块级常量元组，避免每次调用分配新数组。

- 对象索引类型中的 `undefined` 仅用于兼容可选字段声明；运行时字段可以缺省，但显式 `undefined`（包括嵌套字段）直接拒绝，移除字段使用 `delete`。
- 非 JSON 类型不静默转换；原生 `Map` 须由调用方显式转换为普通对象或键值对数组，Memory 不自动恢复原生类型。
- 持久数据类型用 `type` 别名声明。`interface` 没有隐式索引签名，不满足 `Json` 约束。

### 5.2 Accessor

```ts
interface Accessor<T> {
  get<P extends Path<T>>(path: P): DeepReadonly<ValueAt<T, P>> | undefined;
  has<P extends Path<T>>(path: P): boolean;
  keys<P extends Path<T>>(path: P): readonly string[];
  set<P extends Path<T>>(path: P, value: ValueAt<T, P>, opts?: { readonly create?: boolean }): void;
  update<P extends Path<T>>(path: P, fn: (draft: ValueAt<T, P>) => void): void;
  delete<P extends Path<T>>(path: P): boolean;
  root(): DeepReadonly<T>;                    // 整个单元的只读引用
  replace(value: T): void;                    // 整体替换整个单元
}
```

语义见 6.3。相对 6.3 增加了 `root` 与 `replace`：路径至少一段，无法表达"整个单元"，而小分区常需要整体读取或重置。

### 5.3 分区与实体切片

```ts
interface UnitSpec<T extends Json> {
  readonly version: number;                   // 正整数，变更持久结构时加 1
  initialize(): T;                            // 首次安装；确定性，只依赖输入
  migrate(data: Json, fromVersion: number): T; // 版本不一致时调用；抛错则保留原数据并拒绝访问
}

interface PartitionFactory {
  partition<T extends Json>(localId: string, spec: UnitSpec<T>): Accessor<T>; // 在 setup 中调用，每个 localId 一次
}

interface EntitySpace {
  slice<T extends Json>(spec: UnitSpec<T>): EntitySlices<T>; // 声明本模块的切片，在 setup 中调用一次
}

interface EntitySlices<T> {
  of(key: string): Accessor<T>;               // 本模块对该实体的切片；首次访问时惰性初始化或迁移
  has(key: string): boolean;                  // 是否已有本模块的切片，不触发初始化
}
```

- 分区身份为 `(owner, localId)`，owner 由上下文绑定为模块 ID（6.1）。
- 5.4 的写法 `ctx.creeps.of(name)` 在这里拆成两步：先 `slice(spec)` 声明切片的版本与迁移，再由返回的 `EntitySlices` 按实体键取切片。好处是切片的类型和迁移规则只声明一次，访问时不需要重复传入。
- `of(key)` 返回的 Accessor 按实体键缓存。实体记录回收后，旧的 Accessor 失效，再次访问时报错。
- core 切片的类型、只读视图 `core(key)` 和专用写入接口在 M2 随 colony、spawnQueue 加入（第 7 节）。

## 6. 启动判定

### 6.1 模式视图

```ts
type BootMode = 'NORMAL' | 'RECOVERY' | 'FRESH_START' | 'TAKEOVER' | 'SELF_ADOPT'
              | 'SHARD_SEED' | 'STRANDED' | 'DORMANT' | 'AMBIGUOUS';
type Strength = 'strong' | 'medium';          // 强证据、中证据（11.4–11.8）

interface BootModeView {
  readonly mode: BootMode;
  readonly strength: Strength;
  readonly since: number;                     // 进入该模式的 tick
}
```

### 6.2 项目标记

```ts
type ProjectMarker = {                        // Memory[NS].sys，字段含义见 6.7
  sig: string;
  schema: number;
  shard: string;
  epoch: number;
  lastRun: number;
  release: string;
  fp: { rooms: string[]; spawnIds: string[]; creepCount: number };
  mode: { mode: BootMode; strength: Strength; since: number; evidence: string[] };
};
```

### 6.3 boot 特权端口与上下文

```ts
interface RawMemorySummary {
  readonly empty: boolean;                    // 11.3 的 EMPTY：文本为空白，或根键只有引擎默认键且值都是空对象
  readonly parsed: boolean;                   // 能否解析为对象
  readonly rootKeys: readonly string[];
  readonly marker: DeepReadonly<ProjectMarker> | null; // sig 相符的项目标记，否则为 null；schema 与当前不同时只保证 sig 与 schema
}

type BackupState = 'pending' | 'done' | 'failed';

interface BootPort {
  summary(): RawMemorySummary;
  backup(): BackupState;                      // 把原始 Memory 写入备份区；可能跨 tick，重复调用推进进度
  initialize(): void;                         // Memory 为 empty 时加入本项目命名空间，保留其他根键
  clearMemory(): void;                        // 整体清空，并按当前 epoch + 1 重建项目标记
  clearInterShard(): void;                    // InterShardMemory 不可用时什么也不做
  softReset(): void;                          // 下一 tick 生效（5.5）；boot 钩子同 tick 抛错时登记作废
}

interface BootContext extends Omit<ModuleContext, 'processes' | 'instance'> {
  readonly port: BootPort;                    // 只在 boot 阶段有效，其他阶段调用即报错
  readonly sys: Accessor<ProjectMarker>;
  setMode(view: BootModeView): void;
}

interface BootDefinition {
  setup(ctx: BootContext): { boot(): void };
}
```

- kernel 只接受一个 `BootDefinition`，由 app.boot 提供。它在每 tick 的 boot 阶段最先运行，其他模块的上下文中没有 `port`、`sys` 与 `setMode`。
- boot 不经进程表调度，所以 `BootContext` 不含 `processes` 与 `instance`；`onDispose` 登记的清理函数在 kernel 销毁时调用，与模块一致。
- 判定逻辑本身是纯函数 `assess(facts) → {mode, strength, evidence[]}`，属于 app.boot 的内部实现，不进入 contracts。
- `initialize()` 与 `clearMemory()` 由 kernel 生成项目标记的初值（身份、shard、epoch、lastRun、release），指纹与模式为占位值，boot 在同一 tick 经 `sys` 写入。各操作的前置条件与失败语义见 [bootPort](../kernel/bootPort.md)。

## 7. 待加入的接口

以下接口的职责已经在架构设计中确定。它们在第一个使用方交付时加入 contracts，届时补充本文档。

| 接口 | 架构章节 | 加入时机 |
| --- | --- | --- |
| `ModuleContext.services`（`ServiceResolver`）及各服务接口 | 5.4、第 8 章 | M2，随 movement、spawnQueue |
| creep / room / flag 的 core 切片类型、`core(key)` 只读视图与专用写入接口 | 6.4、9.1 | M2，随 colony、spawnQueue |
| 实例准入过滤 `admit` | 5.2 | M2，随 colony.posture |
| `ModuleContext.segments`（`SegmentStore`、`PENDING`） | 6.8 | 第一个使用 segment 的模块交付时 |

## 8. 接口与用法

contracts 只有类型声明，没有初始化步骤和运行时错误。各接口的参数、返回值与错误语义见上文对应小节；类型约束由 `test/contracts/` 的类型测试固定。

一个模块的典型写法：

```ts
import type { ModuleDefinition } from '@/contracts/module';

type SiteData = { lastSeen: number; tasks: { a: string; id: string }[] };
const LAST_SEEN = ['lastSeen'] as const;           // 热路径上的路径声明为常量元组

export const mining: ModuleDefinition = {
  id: 'mining',
  requires: [],
  tier: 'economy',
  priority: 10,
  setup(ctx) {
    const rooms = ctx.rooms.slice<SiteData>({
      version: 1,
      initialize: () => ({ lastSeen: 0, tasks: [] }),
      migrate: (data) => data as SiteData,
    });
    return {
      plan() {
        rooms.of('W1N1').set(LAST_SEEN, Game.time);
      },
    };
  },
};
```

注意事项：

- `setup` 中声明分区与切片，不在钩子里重复声明。
- `get` 返回的引用不得修改；需要修改时用 `update`。
- 进程键、计时标签中的 op 不得包含 tick、creep 名等无界字段。
