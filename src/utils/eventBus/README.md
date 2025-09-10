# EventBus 模块

EventBus 模块为 Screeps 项目提供了一个强大的事件驱动系统，支持发布-订阅模式、事件历史记录、中间件和多种高级功能。

## 功能特性

- ✅ **类型安全**: 完全的 TypeScript 类型支持
- ✅ **发布-订阅模式**: 支持事件的发布和订阅
- ✅ **事件历史记录**: 自动记录事件历史，支持查询和统计
- ✅ **中间件系统**: 支持事件处理管道，可添加日志、性能监控、错误处理等
- ✅ **事件过滤**: 创建只处理特定事件的事件总线
- ✅ **事件聚合**: 将多个事件聚合成一个事件
- ✅ **装饰器支持**: 通过装饰器简化事件的发布和监听
- ✅ **频率限制**: 防止事件洪水攻击
- ✅ **批量处理**: 支持批量发布事件

## 核心组件

### 1. EventBus - 基础事件总线

```typescript
import { EventBus, EventList } from './utils/eventBus';

const eventBus = new EventBus();

// 订阅事件
eventBus.on(EventList.creepSpawn, (data) => {
  console.log(`Creep ${data.creepName} 已生成`);
});

// 发布事件
eventBus.emit(EventList.creepSpawn, {
  creepName: 'harvester1',
  timestamp: Game.time,
});
```

### 2. EnhancedEventBus - 增强事件总线

```typescript
import { globalEnhancedEventBus } from './utils/eventBus';

// 自动记录事件历史
globalEnhancedEventBus.emit(EventList.resourceLow, {
  resourceType: RESOURCE_ENERGY,
  amount: 50,
  from: 'storage1' as Id<ObjectWithStore>,
  to: 'storage1' as Id<ObjectWithStore>,
  timestamp: Game.time,
});

// 查看事件历史
const history = globalEnhancedEventBus.getHistory();
console.log('最近事件:', history.getRecent());

// 查看事件统计
const stats = globalEnhancedEventBus.getEventStats();
console.log('事件统计:', stats);
```

### 3. 中间件系统

```typescript
import {
  MiddlewareEventBus,
  loggingMiddleware,
  performanceMiddleware,
  createRateLimitMiddleware,
} from './utils/eventBus';

const eventBus = new MiddlewareEventBus()
  .use(loggingMiddleware) // 日志记录
  .use(performanceMiddleware) // 性能监控
  .use(createRateLimitMiddleware(50)); // 频率限制
```

## 事件类型

### 资源事件

- `resource:low` - 资源不足
- `resource:transfer` - 资源转移
- `resource:harvest` - 资源采集

### Creep 事件

- `creep:spawn` - Creep 生成
- `creep:death` - Creep 死亡

### 建筑事件

- `structure:built` - 建筑建造完成
- `structure:damaged` - 建筑受损
- `structure:destroyed` - 建筑摧毁

### 房间事件

- `room:claimed` - 房间占领
- `room:scouted` - 房间侦察
- `room:levelUp` - 房间等级提升
- `room:levelDown` - 房间等级下降
- `room:lost` - 房间失去

### 战斗事件

- `combat:started` - 战斗开始
- `combat:ended` - 战斗结束
- `combat:victory` - 战斗胜利
- `combat:defeat` - 战斗失败

## 快速使用

### 1. 使用便捷函数

```typescript
import {
  ResourceEvents,
  CreepEvents,
  onEvent,
  emitEvent,
} from './utils/eventBus';

// 发布资源不足事件
ResourceEvents.emitResourceLow(
  RESOURCE_ENERGY,
  100,
  'storage1' as Id<ObjectWithStore>
);

// 发布 Creep 生成事件
CreepEvents.emitCreepSpawn('harvester1');

// 监听事件
onEvent(EventList.creepDeath, (data) => {
  console.log(`Creep ${data.creepName} 死亡，准备重新生成`);
});
```

### 2. 使用装饰器

```typescript
import { EmitEvent, OnEvent, EventList } from './utils/eventBus';

class CreepManager {
  @EmitEvent(
    EventList.creepSpawn,
    function (this: CreepManager, creepName: string) {
      return { creepName, timestamp: Game.time };
    }
  )
  spawnCreep(creepName: string) {
    // 生成 Creep 的逻辑
    // 装饰器会自动发布 creepSpawn 事件
  }

  @OnEvent(EventList.creepDeath)
  handleCreepDeath(data: { creepName: string; timestamp: number }) {
    console.log(`处理 Creep 死亡: ${data.creepName}`);
  }
}
```

### 3. 事件过滤和聚合

```typescript
import { globalEnhancedEventBus, EventList } from './utils/eventBus';

// 创建资源事件过滤器
const resourceBus = globalEnhancedEventBus.createFilter([
  EventList.resourceLow,
  EventList.resourceTransfer,
  EventList.resourceHarvest,
]);

// 监听过滤后的事件
resourceBus.on(EventList.resourceLow, (data) => {
  console.log('资源管理器收到资源不足警告');
});

// 创建事件聚合器
globalEnhancedEventBus.createAggregator(
  [EventList.combatStarted, EventList.combatEnded],
  EventList.combatVictory,
  (events) => {
    // 聚合逻辑
    return {
      roomName: events[0].data.roomName,
      warType: events[0].data.warType,
      timestamp: Game.time,
    };
  },
  5 // 时间窗口为 5 tick
);
```

## 性能优化

1. **使用中间件进行频率限制**:

   ```typescript
   eventBus.use(createRateLimitMiddleware(100)); // 每tick最多100个事件
   ```

2. **合理设置事件历史记录大小**:

   ```typescript
   globalEventHistory.setMaxHistory(500); // 最多保留500条历史
   ```

3. **使用事件过滤器减少不必要的处理**:
   ```typescript
   const filteredBus = globalEnhancedEventBus.createFilter([
     EventList.resourceLow,
   ]);
   ```

## 最佳实践

1. **使用类型安全的事件监听**:

   ```typescript
   // 好的做法
   onEvent(EventList.creepSpawn, (data) => {
     // data 类型自动推断为 { creepName: string; timestamp: number }
   });
   ```

2. **错误处理**:

   ```typescript
   eventBus.use(errorCatchingMiddleware); // 自动捕获监听器中的错误
   ```

3. **监控性能**:

   ```typescript
   eventBus.use(performanceMiddleware); // 监控事件处理时间
   ```

4. **使用便捷函数**:
   ```typescript
   // 推荐使用便捷函数而不是直接操作事件总线
   ResourceEvents.emitResourceLow(RESOURCE_ENERGY, 100, storageId);
   ```

## 示例

查看 `example.ts` 文件获取完整的使用示例，包括：

- 基础事件发布和监听
- 中间件使用
- 装饰器使用
- 事件历史记录
- 事件过滤和聚合

```typescript
import { eventBusExample } from './utils/eventBus/example';

// 运行所有示例
eventBusExample.runExamples();
```
