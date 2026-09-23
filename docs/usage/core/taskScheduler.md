# TaskScheduler 使用说明

TaskScheduler 把一段单 tick 内算不完的同步计算，用生成器分摊到多个 tick 完成。它是 Core 的内核能力，所有模块的上下文里都直接可用，不需要在 `manifest.requires` 里声明依赖。设计意图、调度算法与故障归属规则见 [TaskScheduler 设计](../../design/core/taskScheduler.md)。

## 取得调度入口

| 调用方 | 入口 | 说明 |
| --- | --- | --- |
| Framework 插件 | `context.tasks` | 已按插件 id 绑定；插件被停用、熔断、卸载、替换或 setup 失败时，它的任务随之释放 |
| App 或普通模块 | `runtime.createContext(name).tasks`，或 `runtime.tasks.bind(name)` | 按模块名绑定；模块名与插件 id 共用同一个命名空间，不能为空，也不要使用内核保留名 `framework` |
| 独立测试 | `createTaskScheduler({ getGame, logging, errorMapper, profiler })` | 必须显式注入四项依赖；`profiler` 允许传 `null` |

```ts
import { createTaskScheduler } from '@/core/taskScheduler';
import { createLogging } from '@/core/logger';
import { createErrorMapper } from '@/core/errorMapper';

const logging = createLogging();
const host = createTaskScheduler({
  getGame: () => Game,
  logging,
  errorMapper: createErrorMapper(logging),
  profiler: null,
});
const tasks = host.bind('myModule');
```

`host`（`TaskHost`）只在 App/Runtime 组合根或独立测试里直接使用；业务代码只接触 `bind` 之后得到的 `TaskScheduler`。Framework 在每个 tick 的收尾阶段自动调用 `host.persist(tick)`（Memory 提交之前，写入跨 global 重启记录）与 `host.drive(tick, cpu)`（Memory 提交之后），业务代码不需要（也不应该）自己调用它们。独立测试中不提供 `memory` 时不做跨 global 记录。

## 提交任务与读取结果

`submit` 只保证实例存在：同 id 已有实例时，无论处于什么状态都返回它；不存在时才从任务体创建。因此每 tick 无条件调用是安全的——完成的结果不会被重算，失败与过期会一直保持可见。

```ts
onTickExecute(context) {
  if (plans.has('W1N1')) return;                       // 已保存结果，不再提交
  const id = 'layout:W1N1';
  const plan = context.tasks.submit(id, () => planLayout('W1N1'), {
    priority: 5,
    label: 'layout', // 固定分类键；'W1N1' 只出现在 id 里，不进入 Profiler 标签。
  });
  if (plan.state === 'done') {
    plans.save('W1N1', plan.result!);                  // 持久化由调用方在钩子里完成
    context.tasks.release(id);
  } else if (plan.state === 'failed') {
    context.env.log.warn(() => plan.failure!.message);  // 需要重试时再 release
  }
}

function* planLayout(roomName: string) {
  const terrain = Game.map.getRoomTerrain(roomName);
  const result = createEmptyPlan();
  for (let y = 0; y < 50; y++) {
    scanRow(terrain, result, y); // 热循环留在普通函数里，不要写进生成器体
    yield;                       // 行与行之间是安全点
  }
  return result;
}
```

任务体是**返回生成器的函数**，不是生成器对象：带参数的生成器函数要包一层，写成 `() => planLayout('W1N1')`。直接传入 `planLayout('W1N1')` 会被类型检查拒绝。

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `submit(id, body, options?)` | 任务 id、返回生成器的任务体、可选配置 | `TaskHandle<T>`；已有实例时返回它，`body`/`options` 被忽略 |
| `get(id)` | 任务 id | `TaskHandle<T> \| undefined`；从未提交、已 `release` 或已被回收时为 `undefined` |
| `release(id)` | 任务 id | 无；活跃的先取消，然后移除实例，下一次 `submit` 重新创建；不存在时是空操作 |

`TaskHandle` 是实例的**实时视图**：可以保存下来跨 tick 读取，同一实例的 `submit`/`get` 返回同一个对象。实例被释放后，句柄停在最后的状态（活跃时被释放即为 `'cancelled'`），不会指向之后按同一 id 新建的实例。

| 字段 | 说明 |
| --- | --- |
| `id` | 提交时传入的 id |
| `state` | `'queued' \| 'running' \| 'done' \| 'failed' \| 'cancelled' \| 'expired'` |
| `result` | `state` 为 `'done'` 时有效 |
| `failure` | `state` 为 `'failed'` 时有效；`PluginFailure` 形状，`pluginId` 是提交该任务的模块名，`phase` 固定为 `'framework'` |
| `cancel()` | 停止活跃实例（变为 `'cancelled'`）并释放生成器；实例保留，`submit` 仍返回它；对终态实例是空操作 |

`TaskOptions` 字段（只在创建实例时生效）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `priority` | `0` | 越大越先获得 CPU；同优先级之间按分片轮转 |
| `deadlineTicks` | 无上限 | 从实例创建起的存活 tick 数上限，超过标记为 `'expired'` |
| `minBucket` | 调度器配置，缺省 5000 | 低于该 bucket 时该任务不驱动，其它任务不受影响 |
| `maxCpuPerTick` | 调度器配置，缺省不限 | 本任务每 tick 的 CPU 软上限，见“CPU 与分片” |
| `label` | 回退到 `id` | Profiler 标签用的分类键，见“规则与注意事项” |

## 需要重算或重试时

| 目的 | 写法 |
| --- | --- |
| 重新计算已完成的结果 | `release(id)`，下一次 `submit` 从任务体重新开始 |
| 失败后重试 | 读取 `failure` 后 `release(id)`；重试的时机与频率由调用方决定，例如隔若干 tick 再释放 |
| 放弃任务 | `release(id)`（或 `cancel()` 后保留实例以便查看状态） |

## CPU 与分片

- 任务主要使用本 tick 常规额度中插件没有用完的部分：每开始一片前，调度器检查普通插件的准入条件（bucket 达到 Framework 的 `minBucket`，且已用 CPU 低于 `Game.cpu.limit` 减 `reserveCpu`）。插件留下的余量少时任务推进得慢。
- bucket 达到 `burstBucket`（缺省 9500）时，任务还可以使用高于水位的盈余：本 tick 的已用 CPU 可以到 `limit` 加上“盈余与一份 `limit` 中的较小者”，并与 `tickLimit` 保持 100 CPU 的距离。有积压任务时 bucket 因此停在水位附近，不再回满；需要满 bucket（例如生成 pixel）时，把 `burstBucket` 配置为 `Infinity` 关闭。
- 调度器不能打断正在执行的一片。分片超出剩余额度的部分从 bucket 扣除；单个分片独自越过 `tickLimit` 会触发 CPU 硬终止。建议单片控制在 1 CPU 以内（约 0.15 ms 的分片即可让调度开销落在噪声范围内）。
- `maxCpuPerTick` 是单个任务每 tick 的软上限：本 tick 累计消耗达到上限后不再开始新的一片，因此最多超出一片的消耗；让出的 CPU 分给其他任务，包括更低优先级的任务。需要限制某个重任务、或让低优先级任务也能每 tick 推进时设置它。
- 调度器配置经 `RuntimeOptions.taskScheduler` 传入，见 [Runtime 使用说明](./runtime.md)。

## 编写任务体

- 生成器只在**安全点**（`yield` 处）会被中断，其余代码一旦开始执行就会运行到下一个 `yield` 或函数结束；热循环应该写在生成器外部的普通函数里，生成器只负责调用分片函数并在分片之间 `yield`，否则会有明显的额外开销。
- **局部变量不能跨 `yield` 持有当 tick 游戏对象**：`Room`、`Creep`、`Structure` 等对象只在当前 tick 有效，生成器的局部变量会跨 tick 存活。需要时在恢复后按 id 重新 `Game.getObjectById` 取得；`RoomPosition`、地形快照、纯数据结构可以放心保留。
- **任务体只做计算**：任务在所有插件收尾与 Memory 提交之后运行，任务体内写入或申请 Memory 分区会抛出 `MemoryManager: modifications are only allowed between begin and end`，提交意图也会被拒绝，异常使该任务失败。任务也不能发布事件：经插件上下文 `events.publish` 会抛错并使任务失败，经 `runtime.bus` 发布的事件不会投递给插件订阅者。需要持久化的结果或需要发出的事件，由提交者在自己的钩子里读取句柄后处理。
- `context.tick` 与 `context.used` 在每次恢复前更新。`used` 是本任务在本 tick 已完成分片的累计 CPU，不含正在执行的这一片，只能用来决定下一片做多少，不能在分片内部当作循环条件（同一片内它不会变化）。
- `PathFinder.search`、`room.find`、市场接口等原生调用是一次性的，中途无法让出；需要控制成本时自行把大搜索拆成多次小搜索，在调用之间 `yield`。
- 任务体本身（返回生成器之前的代码）抛错时，`submit` 直接抛出，不登记实例。
- 在任务体中提交的其他任务从下一 tick 开始驱动，两者没有父子关系。

## 规则与注意事项

- **id 只需要在同一模块内唯一**：不同模块（不同 owner）用相同 id 不会冲突，不需要自己拼前缀。
- **必须提供 label 的情形**：如果 `id` 按业务动态拼接（例如按房间名区分任务实例，如上面例子里的 `'layout:W1N1'`），必须显式传 `label`（如 `'layout'`）。`label` 会被当作 Profiler 标签的一部分，必须来自固定且有限的集合；不提供时缺省用 `id` 本身，动态 id 会造成 Profiler 报告里的标签无界增长。
- **实例会一直保留，直到被释放或回收**：完成的结果、失败与过期都占用 heap。不再需要时调用 `release`；连续 `retainTicks`（缺省 1000）个 tick 没有被 `submit`/`get` 触碰的实例会被自动回收（活跃的先取消），按上面的方式每 tick 轮询的实例不受影响。
- **不保证完成时间**：插件留下的余量少、bucket 低于门限、或被更高优先级任务持续占用时，一个任务可能连续多个 tick 都停留在 `'queued'`；调用方必须容忍“暂时没有结果”。
- **硬终止后的恢复**：若某一片在执行中被 CPU 硬终止，下一次驱动会丢弃该生成器并从任务体重新开始一次；再次被中断则以 `'failed'` 结束，`failure.message` 注明被硬终止中断的次数。`deadlineTicks` 对被中断的任务同样有效。
- **连续多次 global reset 仍未完成的任务会失败**：调度器在内核保留的存储分区（owner `framework`、分区 `tasks`）里记录每个存续实例经历的 global reset 次数。同一 id 的实例连续第 3 次 reset 后重新提交时直接以 `'failed'` 结束，`failure.message` 为 `Task <id> restarted by 3 global resets without completing`，用于阻止“每次都让 global 重建”的任务无限重来。失败后记录即删除：修复代码重新部署后，下一次 reset 会给它新的机会；想立即重试就 `release(id)`。这个判定无法区分是哪个任务导致了重建，同一时段存续的其他任务也会计数；需要跨越多次 reset 的长任务应自行保存检查点。
- **存储开销**：创建或结束一个任务实例会让上述分区在当 tick 或下一 tick 变脏一次；长期运行的实例不产生写入。
- **global reset 后自动恢复**：任务状态只在 heap，reset 后任务注册表清空。按上面“每 tick 提交直到拿到结果”的方式使用即可自然重新开始，不需要额外处理。
