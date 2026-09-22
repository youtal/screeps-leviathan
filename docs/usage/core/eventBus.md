# EventBus 使用说明

EventBus 提供同步的发布订阅。一个应用只有一条总线，由 Runtime 创建，所有模块共享。设计与广播规则见 [EventBus 设计](../../design/core/eventBus.md)。

## 取得总线

| 调用方 | 入口 | 说明 |
| --- | --- | --- |
| Framework 插件 | `context.events`（与 `context.bus` 为同一对象） | 经 Framework 代理：订阅只能在 setup 中进行，停用、卸载后自动取消 |
| App 或普通模块 | `runtime.bus`、`runtime.createContext(name).bus` | 原始总线，订阅需要自行取消 |
| 独立测试 | `createBus(logging)` | 必须显式注入 LoggerFactory |

```ts
import { createBus } from '@/core/eventBus';
import { createLogging } from '@/core/logger';

const bus = createBus(createLogging());
```

## 订阅与发布

```ts
import { eventList } from '@/core/eventBus';

// 插件 setup 中订阅；回调参数的类型由事件名推导。
setup(context) {
  context.events.subscribe(
    { scope: 'global' },
    eventList.structureBuilt, // 'structure:built'
    'builtWatcher',
    (data) => context.env.log.info(() => data.roomName + ' ' + data.structureId)
  );
}

// 发布；返回本轮尝试调用的监听器数量。spawn 是本 tick 取得的 StructureSpawn。
const notified = context.events.publish(
  { scope: 'room', roomName: 'W1N1' },
  'structure:built',
  { roomName: 'W1N1', structureId: spawn.id }
);
```

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `subscribe(scope, eventType, subscriber, listener)` | 作用域、事件名、订阅者名、监听器 | 无 |
| `unsubscribe(scope, eventType, subscriber)` | 与订阅时相同的作用域、事件名、订阅者名 | 无 |
| `publish(scope, eventType, data)` | 作用域、事件名、载荷 | 尝试调用的监听器数量，包含抛错者 |

事件名可以直接写字符串（例如 `'structure:built'`），也可以使用 `eventList` 中的常量；两者类型相同，拼写错误都会在编译期报错。载荷类型为 `DataByEvent<'structure:built'>` 这样的形式，可从 `@/contracts` 导入。

## 作用域

| 写法 | 订阅时接收 | 发布时通知 |
| --- | --- | --- |
| `{ scope: 'global' }` | global 发布，以及所有房间的 room 发布 | global 订阅者 |
| `{ scope: 'room', roomName }` | 同一房间的 room 发布 | 该房间的订阅者与 global 订阅者 |
| `{ scope: 'group', groupId }` | 同一分组的 group 发布 | 该分组的订阅者 |

global 发布不会通知任何房间订阅者；需要通知所有房间时，逐个房间发布。group 事件不进入 global。

## 规则与注意事项

- 监听器同步执行，CPU 计入发布者当前的阶段。回调中只做轻量的状态更新，昂贵计算放到自己的钩子中。
- 同一作用域、同一事件、同一订阅者名只保留一个监听器：再次订阅会替换原监听器并记录 warn。Framework 插件的订阅者名自动加上插件 id 前缀，不会与其他插件冲突。
- 监听器抛错时，总线记录 error 后继续通知其他订阅者，发布者不会收到异常。在 Framework 中，异常进入订阅者的错误边界，该订阅者本 tick 不再收到事件。
- 同一载荷对象会传给所有订阅者，不要在回调中修改它。
- 回调中的订阅与取消只影响之后的发布，本轮通知的订阅者集合在发布开始时已经确定。
- 取消不存在的订阅只记录 warn，不会抛错。
- Framework 插件只能在自己的 setup 中订阅，在任何事件回调中调用 `subscribe`、`services.provide`、`onDispose` 都会抛错，见 [Framework 使用说明](./framework.md)。
- 订阅只存在于 heap。global reset 后需要重新订阅；插件在 setup 中订阅即可，Framework 会在 reset 后重新执行 setup。
- 订阅、取消和通知的明细使用 `EventBus` 作用域的 info 等级，默认关闭。排查事件流时，在创建 Runtime 时开启装配级 info（`createRuntime({ logging: { levels: { info: true } } })`），这会同时打开其他没有单独覆盖 info 的作用域。
