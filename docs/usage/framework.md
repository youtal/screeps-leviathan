# Framework 使用说明

Framework 工厂为 `createFramework`，实例提供可直接导出的 `loop`。当前项目已在 `src/app/runtime.ts` 创建实例，在 `src/app/modules.ts` 注册 RoomShortcuts，并由 `src/index.ts` 导出主循环。

## 最小插件

```ts
import { createFramework, LeviathanPlugin } from '@/core/framework';

const counter: LeviathanPlugin<{ ticks: number }> = {
  manifest: {
    id: 'counter',
    version: 1,
    persistence: { layer: 'critical' },
  },
  migrate: () => ({ ticks: 0 }),
  setup(context) {
    // 同一激活实例只执行一次；在这里注册服务、事件和资源清理函数。
    context.events.subscribe(
      { scope: 'global' },
      'creep:death',
      'counter',
      (data) => context.env.log.info(data.creepName)
    );
  },
  onTickBegin(context) {
    context.persistence.commit((memory) => {
      memory.ticks++;
    });
  },
  onTickExecute(context) {
    // 当前阶段可查询服务并提交意图；本例只演示生命周期。
  },
  onTickEnd(context) {
    // 到期的 dirty 分区会在所有插件收尾之后统一写回。
  },
};

const framework = createFramework({ plugins: [counter] });
export const loop = framework.loop;
```

所有钩子必须同步。返回 Promise 会报告错误。需要高成本计算时，保存进度并拆分到后续 tick。

## 读取 RoomShortcuts 服务

在当前应用上注册依赖插件：

```ts
import { framework } from '@/app';
import { createRoomShortcuts } from '@/modules/roomShortcuts/createRoomShortcuts';

framework.register({
  manifest: { id: 'observer', version: 1, requires: ['roomShortcuts'] },
  onTickExecute(context) {
    const shortcuts =
      context.services.get<ReturnType<typeof createRoomShortcuts>>(
        'roomShortcuts'
      );
    const spawns = shortcuts.getSpawn('W1N1');
    context.env.log.info('spawn count: ' + spawns.length);
  },
});
```

`requires` 填写提供服务的插件 id；`services.get` 填写服务名。二者允许不同。独占服务必须列入 `manifest.provides`，并在 setup 中通过 `services.provide(name, value)` 发布。

## 插件管理

| 实例方法                     | 用途                                            |
| ---------------------------- | ----------------------------------------------- |
| `loop()`                     | 运行当前 tick；同一 tick 重复调用忽略，重入拒绝 |
| `register(plugin)`           | 排队安装插件，下一次 loop 应用                  |
| `enable(id)` / `disable(id)` | 排队启停；依赖停用时使用者自动挂起              |
| `unregister(id)`             | 排队卸载，不存在时忽略，保留插件 Memory         |
| `recover(id)`                | 在 loop 外清除已安装插件的连续失败与熔断状态    |
| `getStatus()`                | 最近一次 tick、safeMode 和结构化故障列表        |

管理命令以批次校验。重复 id、缺失依赖、依赖环或重复服务会使整批失败；当前 tick 不运行业务，旧注册表保留，可在下一 tick 恢复。移除仍被其他插件 requires 的提供者需在同一批中同时移除使用者。

不直接暴露全局控制台命令；需要控制台入口时，由 app 决定如何暴露实例的管理方法。

## 上下文

- `env`：Game 查询与模块日志；`profiler`：可选统计器。
- `bus/events`：同一个插件事件门面。setup 订阅会自动在停用、卸载或 setup 失败后释放。
- `services`：按声明依赖读取服务，setup 发布服务。
- `persistence`：持久插件唯一的状态入口，只提供 `query()` 和 `commit(callback)`。
- `tick`：当前 Game.time。
- `cpu.remaining()`：扣除收尾预留后的剩余 CPU。
- `cpu.admit()`：当前普通任务是否还在预算内。
- `onDispose(callback)`：在 setup 登记额外资源清理，清理按逆序执行。
- `intents`：提交动作与读取本轮、上一轮回执。

Context 可以跨 tick 保留；Memory 根在同一 global 生命周期常驻 heap。每次使用状态时都应从 `context.persistence.query()` 取得当前值，不要长期持有迁移前的嵌套引用。停用后的 Context 不应继续使用，Game 对象不能跨 tick 保存。

## 显式标脏与持久化层

只有需要跨 global reset 恢复数据的插件才在 manifest 中声明持久化。省略配置表示不创建插件 Memory，缓存应由模块自己的闭包管理：

| 层 | 写入时机 | 适用数据 |
| --- | --- | --- |
| `critical` | 修改后的当前 tickEnd | Spawn 队列、殖民任务及 global reset 后必须恢复的状态 |
| `checkpoint` | 从首次标脏起，在间隔到期的 tickEnd | Profiler、历史统计和允许丢失近期变化的数据 |

`manifest.persistence.layer: 'critical'` 表示存储时机，`manifest.critical: true` 表示插件的 CPU 准入和故障等级；两者相互独立。

```ts
const statistics: LeviathanPlugin<{ samples: number }> = {
  manifest: {
    id: 'statistics',
    version: 1,
    persistence: { layer: 'checkpoint', checkpointInterval: 100 },
  },
  migrate: () => ({ samples: 0 }),
  onTickEnd(context) {
    context.persistence.commit((memory) => {
      memory.samples++;
    });
  },
};
```

`query()` 返回递归只读视图，本身不会标脏。`commit(callback)` 在回调执行前标脏，然后把当前键值对象交给回调集中修改并返回回调结果。实现不会使用深层 Proxy，类型断言后直接修改 `query()` 结果会绕过写回协议。

checkpoint 的连续提交不会反复推迟期限；`checkpointInterval: 1` 等价于当 tick 提交。插件安装或版本迁移会立即提交，不受检查点间隔影响。未声明 `persistence` 的插件如果误用 `query/commit` 会抛出错误，不会隐式建立空命名空间。

## 意图提交和核验

```ts
onTickExecute(context) {
  const creep = context.env.getCreep('worker');
  if (!creep) return;
  context.intents.submit({
    subjectId: creep.id,
    channel: 'movement',
    priority: 10,
    execute: () => creep.move(RIGHT),
  });
}
```

`submit` 返回本 tick 的数字序号。相同对象/通道互斥，priority 大者优先，同优先级按提交顺序。共享 `locks` 可表达跨对象竞争，例如两座 spawn 使用同一房间能源预算时采用相同锁名；首版互斥锁不提供资源数量账本。

通道名称是调用者协议。不同通道不代表游戏一定允许动作同时执行；涉及交叉冲突时必须显式使用共同锁。执行函数只保存到本 tick，不进入 Memory。

在 `onTickEnd` 通过 `context.intents.receipts()` 取得本插件回执：

- `accepted`：已调用 API，检查 `apiResult` 的具体返回码。
- `rejected`：冲突或插件/依赖不可用。
- `failed`：执行函数抛错。
- `deferred`：CPU 不足，执行函数未调用，下一 tick 需要重新规划。

`context.intents.previous()` 返回当前 global 生命周期中上一 tick 的本插件回执；global reset 后为空。业务在 begin 检查回执 tick 和当前 Game 状态，核实移动、建造等行为的真实结果。Framework 不会把同步 `OK` 解释为世界行为完成。

## Memory 迁移

manifest.version 为正整数。首次安装 fromVersion 为 0；没有 migrate 的初次安装使用空对象。升级版本必须提供 migrate；返回完整的目标版本 JSON 数据。

```ts
manifest: {
  id: 'counter',
  version: 2,
  persistence: { layer: 'critical' },
},
migrate(oldMemory, fromVersion) {
  const old = oldMemory as { ticks?: number };
  if (fromVersion === 0) return { ticks: 0, enabled: true };
  if (fromVersion === 1) return { ticks: old.ticks ?? 0, enabled: true };
  throw new Error('Unsupported counter version');
}
```

迁移直接接收当前插件键值对象并返回目标对象，不调用 JSON.parse，也不做递归克隆。迁移失败不会写回 RawMemory，但在抛错前对输入对象所做的原地修改不会由 Framework 回滚。卸载保留已经提交的数据，重新注册相同版本会恢复已有数据；global reset 不会重复已完成的数据迁移。

每个 Framework 实例只在首次 loop 读取并解析一次 RawMemory，此后以内存根为唯一事实源。项目代码必须通过 `context.persistence` 修改插件状态；直接修改全局 `Memory` 或在控制台调用 RawMemory 不会更新分区片段，并可能被下次框架写回覆盖。外部编辑后必须触发 global reset。

只有到期的 dirty 分区会执行原生 `JSON.stringify`，clean 分区复用已缓存的 JSON 片段，完全 clean 的 tick 不调用 `RawMemory.set`。默认 RawMemory 无局部 patch API，因此只要发生写入，框架仍会拼装并提交完整字符串；它节省的是未变化对象树的遍历与序列化，以及无变化 tick 的整个写入。提交内容采用直接操作 Memory 时的 JSON.stringify 语义；循环引用等原生错误会使本次写回失败，dirty 状态保留以供后续修复和重试。

## 配置与诊断

| 配置               | 默认值                  | 说明                                           |
| ------------------ | ----------------------- | ---------------------------------------------- |
| `plugins`          | `[]`                    | 初始插件列表                                   |
| `enableProfiler`   | `false`                 | 默认统计器初始开关                             |
| `profilerCheckpointInterval` | `100`       | Profiler 首次标脏后最迟提交间隔                |
| `profiler`         | 自动创建                | 注入已有统计器，null 关闭                      |
| `reserveCpu`       | `5`                     | 收尾预留 CPU                                   |
| `minBucket`        | `1000`                  | 普通插件准入下限                               |
| `failureThreshold` | `3`                     | 连续失败 tick 的熔断阈值                       |
| `getGame`          | 全局 Game               | 测试环境注入                                   |
| `memoryPort`       | RawMemory 与全局 Memory | 注入 read/write/mount；read 每个实例只调用一次 |
| `createContext`    | Framework 默认上下文    | 高级依赖注入；各上下文应共享同一总线           |
| `report`           | console 日志            | 结构化失败处理函数                             |
| `loadSourceMap`    | require('main.js.map')  | 同步加载当前构建的 source map                  |

`critical` 仅给基础服务使用。其失败会阻止剩余业务提交，熔断后需显式 recover。安全模式不会自动执行生存策略。

Profiler 的 calls 包含失败调用。插件健康记录存放在 `Memory.leviathan.framework.pluginHealth`；失败、连续失败恢复和熔断变化会持久化，普通成功 tick 不更新兼容字段 `successes`。错误映射成本单独归入框架标签。

## 验证

```bash
npx tsc --noEmit
npm test
npm run build
git diff --check
```

测试包括插件失败与清理、Memory 单实例一次解析、迁移回滚、global reset 后重载、意图冲突、CPU 降级，以及真实 Rollup 产物在模拟全局环境中的多 tick 执行与堆栈映射。构建默认不上传；仅明确要求部署时执行 `npm run upload:validation`。
