import {
  globalEventBus,
  globalEnhancedEventBus,
  MiddlewareEventBus,
  ResourceEvents,
  CreepEvents,
  EventList,
  EmitEvent,
  OnEvent,
  loggingMiddleware,
  performanceMiddleware,
  createRateLimitMiddleware,
} from './index';

/**
 * EventBus 使用示例
 */
export class EventBusExample {
  private eventBus = new MiddlewareEventBus();

  constructor() {
    this.setupMiddleware();
    this.setupListeners();
  }

  /**
   * 设置中间件
   */
  private setupMiddleware() {
    this.eventBus
      .use(loggingMiddleware)
      .use(performanceMiddleware)
      .use(createRateLimitMiddleware(50)); // 每tick最多50个事件
  }

  /**
   * 设置事件监听器
   */
  private setupListeners() {
    // 监听资源不足事件
    this.eventBus.on(EventList.resourceLow, (data) => {
      const resourceData = data as {
        resourceType: ResourceConstant;
        amount: number;
        from: Id<ObjectWithStore>;
        to: Id<ObjectWithStore>;
        timestamp: number;
      };
      console.log(
        `资源不足警告: ${resourceData.resourceType} 数量: ${resourceData.amount}`
      );
      // 触发资源补充逻辑
      this.handleResourceLow(resourceData);
    });

    // 监听 Creep 死亡事件
    this.eventBus.on(EventList.creepDeath, (data) => {
      const creepData = data as {
        creepName: string;
        timestamp: number;
      };
      console.log(
        `Creep ${creepData.creepName} 在 ${creepData.timestamp} 死亡`
      );
      // 触发重新生成逻辑
      this.handleCreepDeath(creepData);
    });

    // 监听战斗开始事件
    this.eventBus.on(EventList.combatStarted, (data) => {
      const combatData = data as {
        roomName: string;
        warType: 'defense' | 'invasion' | 'raid';
        timestamp: number;
      };
      console.log(
        `房间 ${combatData.roomName} 开始 ${combatData.warType} 战斗`
      );
      // 触发战斗响应逻辑
      this.handleCombatStarted(combatData);
    });
  }

  /**
   * 处理资源不足
   */
  private handleResourceLow(data: any) {
    // 实现资源补充逻辑
    console.log('触发资源补充逻辑');
  }

  /**
   * 处理 Creep 死亡
   */
  private handleCreepDeath(data: any) {
    // 实现 Creep 重新生成逻辑
    console.log('触发 Creep 重新生成逻辑');
  }

  /**
   * 处理战斗开始
   */
  private handleCombatStarted(data: any) {
    // 实现战斗响应逻辑
    console.log('触发战斗响应逻辑');
  }

  /**
   * 使用装饰器的示例方法
   */
  @EmitEvent(
    EventList.creepSpawn,
    function (this: EventBusExample, creepName: string) {
      return {
        creepName,
        timestamp: Game.time,
      };
    }
  )
  spawnCreep(creepName: string) {
    console.log(`生成 Creep: ${creepName}`);
    // Creep 生成逻辑
    // 装饰器会自动发布 creepSpawn 事件
  }

  /**
   * 使用事件监听装饰器的示例方法
   */
  @OnEvent(EventList.resourceTransfer)
  handleResourceTransfer(data: any) {
    console.log('资源转移事件处理:', data);
  }

  /**
   * 演示批量事件发布
   */
  demonstrateBatchEvents() {
    const events = [
      {
        eventType: EventList.resourceHarvest,
        data: {
          resourceType: RESOURCE_ENERGY as ResourceConstant,
          amount: 100,
          from: 'source1' as Id<ObjectWithStore>,
          to: 'source1' as Id<ObjectWithStore>,
          timestamp: Game.time,
        },
      },
      {
        eventType: EventList.creepSpawn,
        data: {
          creepName: 'harvester1',
          timestamp: Game.time,
        },
      },
    ];

    // 使用增强事件总线的批量发布功能
    globalEnhancedEventBus.emitBatch(events);
  }

  /**
   * 演示事件过滤器
   */
  demonstrateEventFilter() {
    // 创建一个只处理资源相关事件的过滤器
    const resourceEventBus = globalEnhancedEventBus.createFilter([
      EventList.resourceLow,
      EventList.resourceTransfer,
      EventList.resourceHarvest,
    ]);

    resourceEventBus.on(EventList.resourceLow, (data) => {
      console.log('过滤器捕获到资源不足事件:', data);
    });

    // 这个事件会被过滤器捕获
    ResourceEvents.emitResourceLow(
      RESOURCE_ENERGY,
      50,
      'storage1' as Id<ObjectWithStore>
    );
  }

  /**
   * 演示事件历史记录
   */
  demonstrateEventHistory() {
    // 发布一些事件
    ResourceEvents.emitResourceTransfer(
      RESOURCE_ENERGY,
      100,
      'source1' as Id<ObjectWithStore>,
      'storage1' as Id<ObjectWithStore>
    );

    CreepEvents.emitCreepSpawn('harvester1');

    // 查看事件历史
    const history = globalEnhancedEventBus.getHistory();
    console.log('最近的事件:', history.getRecent(undefined, 5));

    // 查看事件统计
    const stats = globalEnhancedEventBus.getEventStats();
    console.log('事件统计:', stats);
  }

  /**
   * 运行所有示例
   */
  runExamples() {
    console.log('=== EventBus 示例开始 ===');

    this.spawnCreep('harvester1');
    this.demonstrateBatchEvents();
    this.demonstrateEventFilter();
    this.demonstrateEventHistory();

    console.log('=== EventBus 示例结束 ===');
  }
}

/**
 * 全局示例实例
 */
export const eventBusExample = new EventBusExample();
