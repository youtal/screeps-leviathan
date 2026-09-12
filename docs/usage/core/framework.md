# Framework 使用说明

Framework 工厂为 `createFramework`，实例提供可直接导出的 `loop`。当前项目已在 `src/app/runtime.ts` 创建实例，在 `src/app/modules.ts` 注册 RoomShortcuts，并由 `src/index.ts` 导出主循环。

## 最小插件

```ts
import { createFramework } from '@/core/framework';
import type { LeviathanPlugin } from '@/contracts/plugin';

// 可重建缓存仅在本 global 内存活，不是持久化数据。
let ticks = 0;
const counter: LeviathanPlugin = {
  manifest: {
    id: 'counter',
    version: 1,
  },
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
    ticks++;
  },
  onTickExecute(context) {
    // 当前阶段可查询服务并提交意图；本例只演示生命周期。
  },
  onTickEnd(context) {
    // 此处处理本 tick 的业务收尾；框架不写回存储。
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
| `unregister(id)`             | 排队卸载，不存在时忽略，不触碰外部存储         |
| `recover(id)`                | 在 loop 外清除已安装插件的连续失败与熔断状态    |
| `getStatus()`                | 最近一次 tick、safeMode 和结构化故障列表        |

管理命令以批次校验。重复 id、缺失依赖、依赖环或重复服务会使整批失败；当前 tick 不运行业务，旧注册表保留，可在下一 tick 恢复。移除仍被其他插件 requires 的提供者需在同一批中同时移除使用者。

不直接暴露全局控制台命令；需要控制台入口时，由 app 决定如何暴露实例的管理方法。

## 上下文

- `env`：Game 查询与模块日志；`profiler`：可选统计器。
- `bus/events`：同一个插件事件门面。setup 订阅会自动在停用、卸载或 setup 失败后释放。
- `services`：按声明依赖读取服务，setup 发布服务。
- `tick`：当前 Game.time。
- `cpu.remaining()`：扣除收尾预留后的剩余 CPU。
- `cpu.admit()`：当前普通任务是否还在预算内。
- `onDispose(callback)`：在 setup 登记额外资源清理，清理按逆序执行。
- `intents`：提交动作与读取本轮、上一轮回执。

Context 可以跨 tick 保留；停用后不应继续使用，Game 对象不能跨 tick 保存。

## 持久化停用边界

Framework 不读取或写入 RawMemory，也不挂载全局 Memory。插件上下文不提供 persistence，清单不接受 persistence 配置，插件不接受 migrate 钩子；版本只作为正整数协议标识，不触发数据迁移。旧 JavaScript 插件携带这些字段时，注册批次会明确失败。

健康记录和默认 Profiler 累计值只存在于实例 heap，global reset 后丢失。业务自己的闭包可保存跨 tick 缓存，但不能依赖它跨 reset 恢复。已有游戏存储不会被清理或覆盖，也不会被框架读取恢复。

MemoryManager 仅有占位目录；[Memory 类型契约](../../usage/contracts.md) 不代表可调用的实现，不应导入不存在的工厂。

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

## 配置与诊断

| 配置               | 默认值                  | 说明                                           |
| ------------------ | ----------------------- | ---------------------------------------------- |
| `plugins`          | `[]`                    | 初始插件列表                                   |
| `enableProfiler`   | `false`                 | 默认统计器初始开关                             |
| `profiler`         | 自动创建                | 注入已有统计器，null 关闭                      |
| `reserveCpu`       | `5`                     | 收尾预留 CPU                                   |
| `minBucket`        | `1000`                  | 普通插件准入下限                               |
| `failureThreshold` | `3`                     | 连续失败 tick 的熔断阈值                       |
| `getGame`          | 全局 Game               | 测试环境注入                                   |
| `createContext`    | Framework 默认上下文    | 高级依赖注入；各上下文应共享同一总线           |
| `report`           | console 日志            | 结构化失败处理函数                             |
| `loadSourceMap`    | require('main.js.map')  | 同步加载当前构建的 source map                  |

`critical` 仅给基础服务使用。其失败会阻止剩余业务提交，熔断后需显式 recover。安全模式不会自动执行生存策略。

Profiler 的 calls 包含失败调用。健康记录仅在实例 heap 中累计失败与熔断，recover 清除连续失败和熔断。错误映射成本单独归入框架标签。

## 验证

```bash
npx tsc --noEmit
npm test
npm run build
git diff --check
```

测试包括插件失败与清理、存储零访问、global reset 后 heap 健康状态清空、意图冲突、CPU 降级，以及真实 Rollup 产物在模拟全局环境中的多 tick 执行与堆栈映射。构建默认不上传；仅明确要求部署时执行 `npm run upload:validation`。
