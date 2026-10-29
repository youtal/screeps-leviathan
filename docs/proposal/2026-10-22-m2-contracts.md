# M2 跨模块契约（第 2 步）

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-22 |
| 基线 | `dev`，`ffbd6a9`（0.1.19） |
| 结论 | 待确认 |
| 范围 | [M2 开发计划](./2026-10-22-m2-plan.md)第 4 节第 2 步：服务与世界模型的注入、配置注入、core 切片与 creep 分组、实例准入过滤与殖民地份额、`ModuleContext.stats`、`ModuleContext.segments`；kernel 的实体切片索引（审计 S-25）、硬终止归因（审计 S-06）、segment 读调度与 epoch 起点；schema 版本 |

## 1. 背景

[contracts 设计](../design/contracts/README.md)第 7 节列出了职责已在架构中确定、随第一个使用方加入的接口；M2 的 world、services、colony 与 domains 都依赖它们。按计划，第 2 步先确认这些契约，再写代码。另有四项从 M1 转入、约定在 M2 第一个使用方接入时处理的问题：

| 来源 | 问题 |
| --- | --- |
| [boot 设计](../design/app/boot.md#10-已确认的决定2026-10-21) Q2 | "AMBIGUOUS 只运行生存层"由 kernel.cpu 在准入时执行，在第一个非生存层模块交付前补入 cpu 设计 |
| [代码审计](../audit/2026-10-21-dev-src-code-audit.md) S-25 | 实体切片查找每次 `JSON.stringify` 三元组键，按真实调用模式实施索引并做基准 |
| 代码审计 S-06 | 越过 `tickLimit` 的钩子只归因到 kernel 整体；按进程归因（方案 B）在第一个非生存层模块接入时决定 |
| [bootPort 设计](../design/kernel/bootPort.md#3-操作)"epoch 的起点" | epoch 从 1 开始，Memory 被人工清空后，上一段生涯中 epoch 相同的页会被当作有效页；第一个读取 segment 的业务 store 须处理 |

审计 S-17（`remaining` 是否扣除同层其他已准入进程的预计值）约定在第一个长计算模块接入时决定，属于第 8 步 planner，不在本提案范围。

本提案的设计都落在 contracts 与 kernel、app 的模块设计中，不修订架构文档；与架构写法不同之处在各节注明理由，做法与 contracts 设计对 5.4 的既有偏离（`slice` 与 `of` 两步）相同。

## 2. 总览

| 节 | 内容 | 涉及的设计文档 |
| --- | --- | --- |
| 3 | 服务与世界模型的注入：`ServiceResolver` | contracts、kernel README |
| 4 | 配置的类型与注入 | app.config、app.assembly |
| 5 | core 切片、只读视图与写入接口；creep 分组与遗留池 | contracts、kernel.memory、kernel README |
| 6 | 实例准入过滤、殖民地份额、AMBIGUOUS 只运行生存层 | contracts、kernel.cpu |
| 7 | `ModuleContext.stats` | contracts、kernel.stats |
| 8 | `ModuleContext.segments`：按键整页的 store、读调度、epoch 起点 | contracts、kernel.segments |
| 9 | 实体切片索引（S-25）、硬终止归因（S-06） | kernel.memory、kernel README |
| 10 | schema 版本 | — |
| 11 | 上下文汇总 | contracts |
| 12 | 待决定事项 C1–C6 | — |
| 13 | 实施与验证 | — |

## 3. 服务与世界模型的注入

### 3.1 问题

domains 需要调用 world（roomCache、costMatrix、threat、hub）、services（movement、spawnQueue）与 colony（registry、stage、posture、inventory、governor）的能力。这些能力有状态、有生命周期，按 4.2 只能经上下文注入，不能导入实现。它们本身也是模块：需要 `ModuleContext`（日志、分区、CPU），并在阶段钩子中工作，例如 movement 在 move 阶段结算、spawnQueue 在 arbitrate 阶段出队。所以服务对象只能在提供方自己的 `setup` 中创建，再交给使用方。

### 3.2 接口

```ts
// contracts/services.ts
interface ServiceMap {}                         // 各服务交付时在此加入一项，例如 'services.movement': Movement
type ServiceName = keyof ServiceMap;

interface ServiceResolver {
  get<K extends ServiceName>(name: K): ServiceMap[K];
  provide<K extends ServiceName>(name: K, impl: ServiceMap[K]): void;
}
```

- **提供**：提供方在 `setup` 中调用 `ctx.services.provide(name, impl)`，每个名称只能有一个提供方。`setup` 返回后再调用即抛错。
- **解析**：使用方在 `setup` 中调用 `ctx.services.get(name)` 并持有结果（5.4"setup 时解析一次即可持有"）。提供方必须出现在使用方的 `requires` 或 `optional` 中，否则 `get` 抛错并提示"未声明依赖"。这样拓扑排序保证提供方先 setup，依赖关系也对宿主可见（4.2）。提供方尚未提供或 setup 失败时 `get` 抛错，使用方随之初始化失败；以 `requires` 依赖时，结果与提供方熔断时的连带暂停一致。
- **名称带层前缀**：`world.*`、`services.*`、`colony.*`。边界测试检查 `src/world/` 下不解析 `services.*` 与 `colony.*`，使运行期解析也遵守 4.1 的分层方向。domains 不提供服务（9.5：领域之间只经 services 与 colony 协作）。
- **调用时机**：使用方在任何阶段都可以调用持有的服务对象，提供方本 tick 是否被准入不影响调用。收集意图的服务（movement、spawnQueue）属于生存层，总是运行；只读事实的服务返回其最近一次运行时的结果，接口文档写明新鲜度。
- 服务接口的类型放在 contracts（`contracts/services/<名称>.ts`），由各服务在第 3–6 步交付时加入，本步只交付机制和空的 `ServiceMap`。

### 3.3 成本

`get` 只在 setup 时调用；每 tick 的调用是普通方法调用，没有查表。kernel 为每个名称保存一个提供方记录，heap 成本随服务数有界。

## 4. 配置的类型与注入

计划 9 节 Q2 决定 app.config 的类型与注入方式并入本步。domains、services、colony 不能导入 app（4.2），配置由装配注入。

- **工厂**：需要配置的模块导出工厂 `createX(config: XConfig): ModuleDefinition`，不再导出常量定义；app.assembly 以 app.config 的数据调用工厂，把结果放入模块清单。
- **类型的位置**：配置类型由使用它的模块导出（例如 mining 导出 `MiningConfig`），app.config 以 `import type` 引用。app 位于最上层，可以导入下层的类型；配置类型只有一个使用方，放进 contracts 只会让 contracts 随每个领域的参数变化。多个模块共用的类型（身体模板）已在 `lib.body` 中。孵化优先级不设共享表：每个领域的配置带上自己请求的优先级，数值仍以 [app.config](../design/app/config.md#spawn-priorities) 的表为准。
- **校验**：配置是构建期数据。完整校验放在单元测试中（app.config 的每张表通过对应模块的校验函数）；工厂只保存配置，模块在 `setup` 中再校验一次，失败只使该模块初始化失败，不使装配失败。装配失败会让入口计入一次失败并在下一 tick 重新装配，一张错误的表会把整个正常循环推入冷却。
- **姿态配置表**：由 colony.posture 的工厂接收，它同时产生实例准入过滤（第 6 节）。

## 5. core 切片与 creep 分组

### 5.1 类型

```ts
// contracts/core.ts
type CreepTask = { a: string; id: string; p?: Json };        // 动作、目标 id、少量参数（9.1）
type CreepCore = { o: string; r: string; h: string; t?: CreepTask };
// o：所属进程键（`<模块 ID>` 或 `<模块 ID>:<实例键>`），'' 表示已放入遗留池；r：角色；h：母房

type RoomRole = 'own' | 'remote' | 'reserve' | 'transit';
type RoomCore = {
  c: string;                // 所属殖民地（殖民地以其自有房间名标识）
  role: RoomRole;
  seen: number;             // lastSeen
  stage?: string;           // 殖民地的发展阶段，只出现在殖民地自有房间
  posture?: { eco: string; sec: string; since: number; reason: string };
};
```

- `o` 取完整进程键而不是实例键：分组（第 5.4 节）直接以它查进程表；模块级单例（例如 M4 的侦察）持有的 creep 以模块 ID 为 `o`。
- 阶段与姿态的取值在第 4 步 colony 设计中给出，contracts 届时把 `string` 收窄为联合类型；读取方须容忍未知取值（回滚到旧版本时可能读到新版本写入的值），按默认值处理。
- flag 的 core 切片在 M2 没有使用方，不加入。

### 5.2 只读视图

```ts
interface CoreView<C> {
  core(key: string): DeepReadonly<C> | undefined;  // 不存在时为 undefined；不创建记录
}
// ModuleContext.rooms: EntitySpace & CoreView<RoomCore>；creeps: EntitySpace & CoreView<CreepCore>
```

返回 heap 中数据的只读引用，不复制、不分配，与 `Accessor.get` 的只读约定相同。与 6.4 的 `ctx.creeps.core(name)` 写法一致。

### 5.3 写入接口

```ts
interface CoreWriter<C> {
  create(key: string, value: C): void;   // 已有 core 时抛错
  of(key: string): Accessor<C>;          // 已有 core 的读写访问器；不存在时抛错
}
// 取得方式：ctx.creeps.coreWriter()、ctx.rooms.coreWriter()；未获授权时抛错
```

- **授权**：kernel 不认识业务模块，授权名单由装配给出：`KernelOptions.coreWriters = { creeps: ['registry', 'spawnQueue'], rooms: ['registry', 'stage', 'posture'] }`（模块 id 以第 4–6 步的实际定义为准）。未获授权的模块调用 `coreWriter()` 即抛错，应在 setup 中调用，使配置错误表现为初始化失败。
- **字段归属**：room core 的 `c`、`role`、`seen` 由 registry 写，`stage` 由 colony.stage 写，`posture` 只由 colony.posture 写（9.3.3）。kernel 不按字段限制，归属由 colony 的设计约定并以单元测试检查。
- **creep 的写入**（6.4：由 colony 与 spawnQueue 经专用接口写入）：spawnQueue 在 `spawnCreep` 返回 `OK` 时 `create`；改归属、放入遗留池、认领由 colony 执行。domains 写任务字段 `t` 的方式见 C1。
- **core 的版本与迁移**：`UnitSpec` 含 `initialize` 与 `migrate`，是业务规则，不能放在 kernel；由装配以 `KernelOptions.core = { creeps: UnitSpec<CreepCore>, rooms: UnitSpec<RoomCore> }` 传入，app.assembly 定义。core 只经 `create` 写入初值，不会被惰性初始化，所以 spec 的 `initialize` 不会被调用，实现为抛错。

### 5.4 creep 分组与遗留池

9.1："sense 阶段遍历一次 `Game.creeps`，按 `o` 分组交给各实例；没有对应实例的 creep 进入遗留池"。4.4 把这一遍历划给 kernel。分组只是按字段查表，不是业务判断，由 kernel.lifecycle 在 sense 阶段的第一个钩子之前执行：

```text
清空各进程的成员数组与遗留池（length = 0，数组跨 tick 复用）
对 GamePort.creepNames() 中的每个名称：
  core = creep core 的数据（经第 9.1 节的索引，O(1)）
  进程 = core ? 进程表[core.o] : undefined          { [进程键]: 模块运行记录或实例记录 }
  进程存在 → 放入该进程的成员数组；否则 → 放入遗留池
```

```ts
// ModuleContext 与 InstanceContext 增加：
members(): readonly string[];   // 本 tick 归属本进程的 creep 名称（含孵化中的 creep）
// ModuleContext 另增加：
legacy(): readonly string[];    // 本 tick 的遗留池
```

- 返回的数组只在本 tick 有效，下一 tick 被复用，调用方不得跨 tick 持有或修改。
- 归属于暂停、熔断或本 tick 未被准入的进程的 creep 仍归该进程，不进入遗留池：暂停的去向由姿态配置决定（9.3.3），不由分组隐式改变。
- 本 tick 内改写 `o`（转交、放入遗留池）在下一 tick 的分组中生效。孵化成功的 creep 当 tick 已进入 `Game.creeps`，但名称快照取自 tick 起点，同样在下一 tick 分组。
- 成本：每个 creep 两次 Map 查找，没有对象分配。只在运行业务阶段的 tick 执行。

## 6. 实例准入过滤与殖民地份额

### 6.1 接口

5.2 规定 app 向 kernel 注册 `admit(instanceKey) → {run, tierOverride?}`。5.3 的殖民地份额还需要实例所属的殖民地、殖民地的权重与姿态优先级，所以把它们放进同一个过滤对象：

```ts
// contracts/cpu.ts
type AdmitDecision = {
  readonly run: boolean;        // false：本 tick 不运行，判为空闲（不计落选）
  readonly tier?: Tier;         // 覆盖实例的层级（tierOverride）
  readonly colony?: string;     // 所属殖民地；缺省时不参与殖民地份额
};
type ColonyShare = { readonly name: string; readonly weight: number };

interface AdmitFilter {
  revision(): number;                                    // 决定或份额变化时加 1
  decide(processKey: string, tier: Tier): AdmitDecision; // 只对非生存层的实例调用
  colonies(): readonly ColonyShare[];                    // 按姿态优先级从高到低（9.3.3 的 CPU 降级顺序）
}
```

- **来源**：colony.posture 的工厂同时返回模块定义与过滤对象，app.assembly 把过滤对象作为 `KernelOptions.admit` 交给 kernel。过滤对象在 posture 的 setup 之前返回"全部运行、无殖民地"。kernel 不理解姿态，也不解析实例键：从实例键找到房间、再经 registry 找到殖民地，是过滤对象的事。约定殖民地范围的实例键以房间名开头（`W1N1:<sourceId>`），由 colony 设计写明。
- **姿态只在 NORMAL 生效**（9.3.3）由过滤对象自己根据 `ctx.mode` 处理；非 NORMAL 时它仍返回 `colony`，使殖民地份额与按殖民地的 CPU 统计不中断。
- **缓存**：kernel 在实例记录上缓存决定及其 revision，只有 `revision()` 变化或实例新建时才重新调用 `decide`，`colonies()` 同样按 revision 缓存。姿态与殖民地成员变化很慢，平时每 tick 只多一次 `revision()` 调用。
- **生存层**：声明为生存层的实例不经过滤，总是准入（5.2）；过滤可以把非生存层实例提升到生存层。
- 没有过滤对象时（M1 与只测 kernel 的测试），行为与 M1 相同。

### 6.2 AMBIGUOUS 只运行生存层

boot Q2：模式视图为 AMBIGUOUS 时，kernel.cpu 把全部非生存层进程判为空闲，不计落选，也不调用过滤对象（避免过滤把实例提升到生存层）。其他模式的特殊行为（例如接手时的 stabilize 只运行生存层，11.6）在第 11 步设计 app.boot 时处理，届时扩展此规则。

### 6.3 殖民地份额

在 [cpu 设计](../design/kernel/cpu.md#32-准入流程)第 3.2 节的流程中，经济、维护、规划三层各自按以下顺序判定，生存层不变：

```text
A = 本层可分配量（poolEnd − expected）
1. 没有殖民地的进程（模块本身、无 colony 的实例）：按原有顺序判定，占用 A
2. 按 colonies() 归一化权重：cap_c = A剩余 × weight_c / Σweight
   按 colonies() 的顺序逐个殖民地，殖民地内连续落选者在前、其余按执行顺序；
   预计耗用放得进 cap_c 的剩余与 A 的剩余时准入
3. 第 2 步中因份额落选的实例（不含因依赖落选的），按连续落选次数从多到少再判定一次，只受 A 的剩余约束
```

- 第 3 步使某个殖民地没用完的份额可以给其他殖民地，避免 bucket 回补期间有 CPU 闲置；它们的连续落选次数在第 2 步已经加 1，下一 tick 仍然优先。是否保留这一步见 C2。
- **运行时的预算视图**：实例的 `ctx.cpu.remaining()` 取"本层剩余"与"所属殖民地本层剩余份额"中的较小者。kernel 在每次实例钩子计量后累加殖民地的 `spent`（一次加法），视图按（殖民地，层）惰性创建并缓存；实例上下文的 `cpu` 在实例所属殖民地变化时改指新视图。契约 `CpuBudget` 不变。
- **单殖民地时**：份额等于本层全部，与 M1 的差别只是没有殖民地的进程先判定。没有过滤对象时与 M1 完全相同。
- **成本**：每 tick O(进程数 + 殖民地数)；殖民地内的排序只在 revision 变化时重建，连续落选者的前置沿用现有做法。
- kernel 按殖民地汇总各层耗用，写入统计页（5.8"按殖民地记录各层 CPU"，第 7 节）。

## 7. `ModuleContext.stats`

[stats 设计](../design/kernel/stats.md)第 1 节约定业务指标的上报接口随第一个上报的模块加入；计划约定第 12 步的上报接口在本步确定。

```ts
// contracts/stats.ts
interface StatsReporter {
  add(colony: string, metric: string, delta: number): void;  // 窗口内累加，例如采集量
  set(colony: string, metric: string, value: number): void;  // 窗口内取最后值，例如库存位置
}
```

- 指标名写出为 `<模块 ID>.<metric>`，`metric` 必须取自有限集合（与计时标签同一约束）。上报器按 `metric` 缓存拼好的完整名，热路径不拼接字符串。
- 5.8 与 10.8 的业务指标都按殖民地记录，所以 `colony` 是必填参数；没有不按殖民地的业务指标使用方，不另设接口。
- 统计页正文增加 `colonies: { [殖民地]: { [指标]: 值 } }`；累加值是窗口内的总和，采集端除以窗口长度 `n` 得到每 tick 速率。kernel 自身按殖民地汇总的各层耗用写在同一对象下（`cpu.<层>`）。
- **体积**：10 个殖民地、每个 30 项指标约 8 KB；超限时的截短顺序在 stats 设计中补充（先去掉殖民地指标中的非验收项）。
- 实例上下文不提供 `stats`：实例经所属模块的上报器上报，与持久数据的归属方式相同。

## 8. `ModuleContext.segments`

### 8.1 M2 的 store：按键整页

计划 D2 把读调度与 `SegmentStore` 提前到 M2，分片 store（多个键共用一页）仍在 M5。M2 唯一的业务使用方是 planner 的布局计划（30–49 页，按殖民地分片）。M2 的 store 因此采用"一个键独占一页、每次整页覆盖"：

```ts
// contracts/segments.ts
const PENDING: unique symbol;                 // Symbol.for('leviathan.pending')
type SetResult = 'queued' | 'too-large' | 'full';

interface SegmentAccess {
  store<T extends Json>(name: string): KeyedStore<T>;  // 只能取得分配给本模块的 store；在 setup 中调用
}

interface KeyedStore<T> {
  get(key: string): DeepReadonly<T> | undefined | typeof PENDING; // 没有该键为 undefined；尚未载入为 PENDING 并登记读取
  set(key: string, value: T): SetResult;                          // 整页覆盖；不抛错（6.8 安全规则 4）
  delete(key: string): void;
}
```

- **与 6.8 写法的差异**：6.8 写作 `get<T>(store, key)`，每次调用传 store 名与类型参数。这里先以 `store(name)` 取得类型化的句柄，理由与 `slice(spec)` 相同：类型和归属只声明一次，热路径不重复校验 store 名。语义（`PENDING`、登记加载请求、使用方必须处理 `PENDING`）不变。
- **`PENDING` 用 `Symbol.for`**：官服每 tick 可能在同一 global 中重新执行模块（[内核设计](../design/kernel/README.md#6-入口正常循环与保底循环)第 6 节），以注册表符号保证不同轮次的模块代码比较的是同一个值。
- **store 的分配**：由装配给出 `KernelOptions.stores = [{ name: 'layout', owner: 'planner', pages: [30, 49], priority: 1 }]`。kernel 校验页号在 0–99、不与 kernel 自用的 50 页与 80–89 页及其他 store 重叠；owner 与模块 id 不符时 `store(name)` 抛错（6.8 安全规则 1）。
- **键到页的映射**保存在 kernel 分区 `part.kernel.segments`：`{ [store]: { [键]: [页号, 分配 tick] } }`。首次 `set` 一个键时取本 store 范围内最小的空闲页并记录；没有空闲页时返回 `full`。`delete` 删除映射与 heap 缓存，不写 segment（旧内容由第 8.3 节的检查排除）。
- **安全规则 3**（未加载过的页禁止写入）：每页只属于一个键，`set` 写出该键的全部内容，属于 6.8 中"整页覆盖"的例外，不需要先读。
- **编码**：`set` 立即 `JSON.stringify` 并检查"页头 + 正文 ≤ 单页上限"，超限返回 `too-large`，不改变已有内容；通过后更新 heap 缓存（保存副本）并把页放入待写队列。写回沿用 M1 的调度：按优先级与变脏时长、每 tick 最多 `SEG_WRITES_PER_TICK` 页、低优先级在 bucket 低时推迟；同一页再次 `set` 覆盖未写出的内容，合并自然发生。
- **heap 缓存**：载入后解析一次并在本 global 内保留（6.8：heap 是工作副本，每页在一个 global 内只读一次）。布局计划每殖民地约数 KB 到数十 KB。

### 8.2 读调度

6.8 规定的读调度落在 segments 的 `commit()`：

- 读取请求记为 `{页号, 优先级, 首次请求 tick}`，请求一直保留到页被载入。每 tick 按 `优先级 × SEG_READ_AGING − 等待 tick 数` 从小到大选出最多 10 页，只调用一次 `setActiveSegments`；`SEG_READ_AGING` 默认 20，即等待 20 tick 抵一级优先级，低优先级请求不会饿死。
- 优先级：backup 回读为 0，layout 为 1；M4 的情报为 2。reset 后的预热顺序"自有房间布局 → 自有房间情报 → 其他"由 store 优先级给出：布局只为自有殖民地存在，情报的自有房间优先在 M4 设计情报 store 时处理。使用方在需要时调用 `get`，不另设预取接口。
- 读过的页在下一次提交时退出激活集（M1 已实现）。

### 8.3 epoch 起点

问题：Memory 被人工清空或中间运行过其他代码后，epoch 从 1 重新开始，上一段生涯中 epoch 同为 1 的布局页会通过 6.8 安全规则 2 的检查，planner 可能把其他房间或过期的布局当作当前计划。

处理（C4 的方案 A）：页头增加键 `k`；读取时除 owner 与 epoch 外，要求 `k` 等于所读的键，且页头的 `g`（写出 tick）不早于映射中记录的分配 tick。映射保存在 Memory 中，与 Memory 一起被清空；清空后重新分配的键的分配 tick 晚于上一段生涯的任何写出，旧页必然被判为空页。不满足时 `get` 返回 `undefined`，并在 heap 中记住"该页为空"，不反复登记读取。这一检查只依赖世界时间单调，与 9.2 命名规范的唯一性保证范围相同（服务器时间回滚不在保证内）。

## 9. kernel 内部

### 9.1 实体切片索引（S-25）

本步的使用方使 `of(key)` 与 `core(key)` 成为每 tick 按"creep 数 × 模块数"调用的热路径。按审计 S-25 的方案 B 实施：

- 每个切片声明（以及每个空间的 core）持有 `{ [实体键]: 单元 }` 的 Map，命中且单元有效时直接返回缓存的访问器，不再拼接 JSON 键。
- `maintain` 回收记录时，按记录上的 owner 表逐个删除各声明缓存中的项；软重置与 `clear` 时整体清空。creep 名称一生只用一次，缓存必须随回收清理，否则 heap 持续增长。
- 契约不变。验证：命中路径不调用 `JSON.stringify`（以调用次数确认，反向验证换回基线后失败）；回收后缓存项被删除；bench 增加"1000 个 creep × 3 个 owner 的切片查找"用例，并记录改动前后的结果。

### 9.2 硬终止归因（S-06）

M2 起有非生存层模块，planner 等长计算模块的某个钩子若确定性地越过 `tickLimit`，按 M1 的处理（终止只归因到 kernel 整体），连续 `KERNEL_CRASH_LIMIT` 次后整个正常循环冷却 100 tick，期间只有保底在运行，冷却结束后重复。方案 B（C3）：

- 入口持有一个归因槽 `{ key: string | undefined }` 与终止计数表 `{ [进程键]: 被终止次数 }`，经 `KernelOptions` 交给 kernel；两者在入口的 heap 中，kernel 重建后仍在。
- lifecycle 在调用每个钩子与每个模块的 `setup` 前把进程键写入槽位，阶段循环结束后清空（每次调用一次赋值）。
- 入口在下一 tick 发现上一 tick 被终止时，若槽位有键，把该键的终止计数加 1，不计入入口的连续失败次数；槽位为空（终止发生在 Memory 加载、提交等 kernel 自身的工作中）时按 M1 计为 kernel 的一次失败。
- 新 kernel 创建运行记录或实例记录时，以终止计数为初始失败次数；达到 `BREAKER_THRESHOLD` 时直接熔断（模块的 `setup` 被终止达到阈值时，记为初始化失败、不再调用 `setup`）。熔断可经 `ops.recover` 恢复，恢复时清除计数。
- 进程的钩子成功运行一次后，kernel 删除它在计数表中的项（计数表为空时只多一次 `size` 判断）。
- 代价：每 tick 每次钩子调用一次赋值；入口与 kernel 之间多一个选项。每次终止仍丢弃一次 kernel 并在下一 tick 重新装配（M1 的做法不变），被归因的进程最多造成 `BREAKER_THRESHOLD` 次重建。

## 10. schema 版本

计划要求确认新增分区与切片是否改变 schema 版本。结论：**不改变，不需要两步迁移**。

- schema 描述命名空间的结构（`sys`、`part`、`rooms`、`creeps`、`flags` 与单元包络）。M2 新增的只是这些空间中的单元：core 切片、各模块的分区与切片、`part.kernel.segments`，命名空间结构不变。
- 源码核实：M1 的加载（`src/kernel/memory/runtime.ts` 的 `load`）登记全部单元，包括未声明的 owner 与 core，并原样写回；M1 的 lifecycle 不提供房间事实，不回收房间记录。所以回滚到 0.1.19 时 M2 写入的数据被保留，不会被判为结构不符。
- 单元格式的变化由各单元的 `version` 与 `migrate` 处理，仍须遵守 13.3 的两步发布（`migrate` 会收到高于自身版本的 `fromVersion`）。
- 验证随 R1：13.3 要求的"上一版本 → 新版本 → 回滚"私服场景以 0.1.19 为上一版本运行一次。

## 11. 上下文汇总

```ts
interface ModuleContext {
  readonly id: ModuleId;
  readonly log: Logger;
  readonly measure: Measure;
  readonly cpu: CpuBudget;
  readonly memory: PartitionFactory;
  readonly rooms: EntitySpace & CoreView<RoomCore> & { coreWriter(): CoreWriter<RoomCore> };
  readonly creeps: EntitySpace & CoreView<CreepCore> & { coreWriter(): CoreWriter<CreepCore> };
  readonly flags: EntitySpace;
  readonly segments: SegmentAccess;           // 新增（6.8）
  readonly services: ServiceResolver;         // 新增（5.4）
  readonly stats: StatsReporter;              // 新增（5.8）
  readonly mode: BootModeView;
  readonly processes: ProcessTable;
  readonly console: ConsoleRegistry;
  members(): readonly string[];               // 新增（9.1）
  legacy(): readonly string[];                // 新增（9.1、11.6）
  instance(key: string): InstanceContext;
  onDispose(fn: () => void): void;
}

interface InstanceContext {
  readonly key: string;
  readonly log: Logger;
  readonly measure: Measure;
  readonly cpu: CpuBudget;                    // 按所属殖民地的份额（第 6.3 节）
  members(): readonly string[];               // 新增
}
```

- `BootContext` 在现有的省略之外，再省略 `segments`、`services`、`stats`、`members`、`legacy`：boot 在模块 setup 之前运行，这些能力尚不存在。
- kernel 新增的宿主选项：`coreWriters`、`core`、`admit`、`stores`、归因槽与终止计数表（第 5、6、8、9 节），由 app.assembly 与入口提供。

## 12. 待决定事项

| 编号 | 事项 | 可选方案 | 建议 |
| --- | --- | --- | --- |
| C1 | domains 写 creep 任务 `t` 的途径 | A：经 colony 提供的服务写入（例如 `setTask(name, owner, task)`，校验 `o` 等于调用方的进程键），与 6.4"creep 由 colony 与 spawnQueue 经专用接口写入"一致；B：kernel 给每个进程一个只能写自己 creep 的 `t` 的接口，按分组结果校验归属 | **A**。B 少一层转发，但与 6.4 的写入权限表不符，须修订架构 6.4；每 tick 的转发只是一次方法调用 |
| C2 | 殖民地份额的余量 | A：第 6.3 节第 3 步，份额落选的实例可用其他殖民地没用完的份额；B：严格按份额，用不完的本 tick 闲置 | **A**。B 在 bucket 回补期间会让 CPU 闲置；单殖民地时两者相同 |
| C3 | 硬终止归因（S-06） | A：保持 M1，只归因到 kernel 整体；B：第 9.2 节，按进程归因并熔断 | **B**。M2 起有长计算模块，A 下一个确定性超限的钩子会使整个正常循环反复冷却 |
| C4 | epoch 起点 | A：第 8.3 节，页头带键，读取时要求写出 tick 不早于键的分配 tick；B：epoch 改为以开局或清空时的 `Game.time` 为值，须修订架构 6.7"加 1"的规定 | **A**。不修订章程，只影响业务 store；M1 的 backup 与 stats 不受影响（bootPort 设计已说明） |
| C5 | `SegmentStore` 的形态 | A：第 8.1 节的类型化句柄 `store(name)`；B：6.8 原写法 `get<T>(store, key)` | **A**。类型与归属只声明一次，与 `slice(spec)` 一致 |
| C6 | 配置的类型位置 | A：第 4 节，由使用方模块导出，模块以工厂接收；B：集中放在 `contracts/config.ts` | **A**。配置类型只有一个使用方，B 会让 contracts 随每个领域的参数改动 |

## 13. 实施与验证

确认后在本步交付：

| 部分 | 内容 | 验证 |
| --- | --- | --- |
| contracts | `services.ts`、`core.ts`、`segments.ts`、`stats.ts`，`cpu.ts` 的过滤类型，`context.ts`、`memory.ts`、`boot.ts` 的上下文变化 | `test/contracts/` 的类型测试 |
| kernel.context、lifecycle | 服务的提供与解析及依赖检查；creep 分组与遗留池；归因槽 | 单元：未声明依赖时 `get` 抛错、`setup` 后 `provide` 抛错、重复提供；分组与遗留池、改写 `o` 下一 tick 生效、暂停进程的 creep 不进遗留池；分组不分配对象（以数组身份确认） |
| kernel.memory | core 的视图与写入、授权；切片索引（S-25）；房间回收以 core 为事实 | 单元：未授权时抛错、`create` 重复抛错；索引命中不调用 `JSON.stringify`（反向验证）；回收清理缓存；bench 新用例 |
| kernel.cpu | 过滤与 revision 缓存、殖民地份额、AMBIGUOUS 只运行生存层、按殖民地的预算视图 | 单元：revision 不变时不调用 `decide`（调用次数）；份额与余量；生存层不经过滤；AMBIGUOUS 下非生存层为空闲且不计落选；没有过滤对象时与 M1 结果一致 |
| kernel.segments | 按键整页 store、映射分区、读调度、页头 `k` 与分配 tick 检查 | 严格平台模拟：`PENDING` 到载入、超限与 `full`、老化排序不饿死、清空后旧页为空、页不属于本模块时抛错 |
| kernel.stats | 上报器与殖民地指标、截短 | 单元 |
| 入口 | 归因槽与终止计数（C3 为 B 时） | 混沌测试：同一进程连续 3 次被终止后熔断，其他模块照常运行；槽位为空时按 M1 计数（反向验证：去掉归因后测试失败） |
| app.assembly | `coreWriters`、`core` 的 spec、`admit`、`stores` 的装配；模块清单仍为空 | 单元；私服 kernel-smoke |

kernel 的行为变化都对没有业务模块的配置透明：M1 的全部测试与 7 个私服场景须保持通过。

确认后更新的设计文档：contracts README（第 3、5、7 节，第 7 节删去已加入的接口）、kernel README（第 2、4、6 节）、kernel 的 cpu（第 3、4 节）、memory、segments（第 1、4、5、6 节）、stats（第 1、3 节）、bootPort（"epoch 的起点"改为指向 segments 的处理）、app.config 与 app.assembly；boot 设计第 10 节 Q2 注明已在 cpu 设计中落实；代码审计 S-06、S-25 追加整改记录。

## 14. 结论

待用户对 C1–C6 作出决定。
