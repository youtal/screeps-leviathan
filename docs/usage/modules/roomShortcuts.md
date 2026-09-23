# RoomShortcuts 使用说明

RoomShortcuts 按房间查询建筑、Source 与 Mineral。它为每个有视野的房间缓存对象 id，每次查询用 `getObjectById` 取回本 tick 的对象，避免重复调用 `room.find`。设计见 [RoomShortcuts 设计](../../design/modules/roomShortcuts.md)。

## 取得服务

应用已在 `src/app/modules.ts` 以插件 `roomShortcuts` 注册本模块，服务名同为 `roomShortcuts`。使用方在 manifest 中声明依赖，并在使用时读取服务：

```ts
import { RoomShortcutsService } from '@/modules/roomShortcuts';

framework.register({
  manifest: { id: 'defense', version: 1, requires: ['roomShortcuts'] },
  onTickExecute(context) {
    const shortcuts = context.services.get(RoomShortcutsService);
    for (const tower of shortcuts.getTower('W1N1')) {
      // tower 是本 tick 的对象，不要跨 tick 保存。
    }
  },
});
```

按 [Framework 使用说明](../core/framework.md) 的规则，在使用时调用 `services.get`，不要在 setup 中保存服务对象。

`RoomShortcutsService` 把服务名 `roomShortcuts` 与公共 `RoomShortcuts` 查询接口绑定。消费者无需从工厂返回值推导类型；令牌接口不暴露提供者的缓存清扫方法 `sweep`。现有 `services.get<T>('roomShortcuts')` 字符串写法仍可用。

独立创建时传入模块上下文和可选配置。工厂在创建时向总线订阅建筑事件，每个 global 只应创建一次；不经 Framework 使用时，这些订阅不会自动取消。

```ts
const shortcuts = createRoomShortcuts({
  ...runtime.createContext('roomShortcuts'),
  cacheLeaseTicks: 3000,
});
```

## 配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `cacheLeaseTicks` | `5000` | 缓存租约长度（tick）。到期后的第一次查询重新扫描房间。小数向下取整，小于 1 按 1 处理，非有限数按 5000 处理 |
| `forceReInit` | `false` | 每次查询都重新扫描房间，只用于诊断和测试 |
| `sweepIntervalTicks` | `500` | 清扫间隔（tick）。每隔这么久删除一次已超过租约的房间索引与闲置的无视野告警标记，归一化规则同上 |

## 查询接口

所有接口都只接受房间名。

| 返回数组（无结果时为 `[]`） | 返回单个对象（无结果时为 `undefined`） |
| --- | --- |
| `getSpawn`、`getExtension`、`getRampart`、`getRoad`、`getWall`、`getKeeperLair`、`getPortal`、`getLink`、`getLab`、`getContainer`、`getTower`、`getPowerBank`、`getSource` | `getObserver`、`getPowerSpawn`、`getExtractor`、`getNuker`、`getFactory`、`getStorage`、`getTerminal`、`getInVaderCore`、`getMineral` |

返回值的类型是对应的具体类型，例如 `getTower` 返回 `StructureTower[]`，`getStorage` 返回 `StructureStorage | undefined`。

## 结果语义

- **包含所有可见建筑，不区分所有者**。查询基于 `FIND_STRUCTURES`：查询有视野的他人房间时，会得到他人的 spawn、tower 等；无主建筑（道路、墙、container 等）也在结果中。只需要己方建筑时自行筛选，例如 `getTower(roomName).filter((t) => t.my)`。
- 房间里没有某类建筑是正常情况：返回空值，不记录日志。
- 已消失的对象会被过滤。单对象接口只看缓存中的第一个 id，该对象消失时返回 `undefined`，直到下一次重新扫描。
- 房间当前没有视野时返回空值并丢弃该房间的缓存；每次失去视野后的第一次查询记录一条 warn，恢复视野后的第一次查询重新扫描。

## 缓存何时更新

- 第一次查询某个房间时扫描一次（三次 `room.find`），之后的查询只调用 `getObjectById`。
- 新建与摧毁的建筑依靠两个事件增量更新。没有事件时，变化要等到租约到期后的下一次查询才会出现，最长约 `cacheLeaseTicks` 个 tick。
- 需要及时反映变化时，由事件生产者以 global 或 room 作用域发布下面两个事件。模块以 global 订阅，收不到 group 发布：

| 事件 | 载荷 | 模块的处理 |
| --- | --- | --- |
| `structure:built` | `{ roomName, structureId }` | 已缓存的房间追加该建筑；对象不存在或不在该房间时丢弃整个房间的缓存 |
| `structure:destroyed` | `{ roomName, structureId, ruinId }` | 通过 `ruinId` 读取废墟，核对房间与原建筑 id 后删除；无法核对时丢弃整个房间的缓存 |

`ruinId` 必须是该建筑留下的废墟。取不到废墟时（例如核弹摧毁不产生废墟）不要伪造 id，这类变化由租约兜底。

## 注意事项

- 缓存只在 heap 中，不占用 Memory；global reset 后清空，下一次查询重新扫描。
- 缓存不设容量上限，按超时回收：插件每隔 `sweepIntervalTicks` 清扫一次，删除超过租约且没有再被查询的房间索引，因此占用只与“最近一个租约内查询过的房间数”相关。内部 `sweep(tick)` 由提供者插件调用，不属于令牌发布的消费者接口。
- 超过租约的房间不再接收建筑事件的增量更新，下一次查询会整体重扫。
- 失去视野的告警标记闲置一个租约后被回收：长期无视野且持续被查询的房间，大约每个租约会再告警一次。
- 查询会解析缓存中的每个 id，CPU 与结果数量成正比。同一 tick 内多次需要同一结果时，保存到局部变量复用。
- 日志：房间扫描失败、建成事件指向的对象不存在时记录 error；失去视野、事件与房间或废墟不符、重复的建成事件记录 warn；扫描、失效等明细使用 info（默认关闭）。
