import { EventBus } from './EventBus';
import { EventHistory, globalEventHistory } from './EventHistory';
import { EventType, DataByEvent } from './types';

/**
 * 增强版事件总线，包含历史记录功能
 */
export class EnhancedEventBus extends EventBus {
  private history: EventHistory;
  private enableHistory: boolean = true;

  constructor(history?: EventHistory) {
    super();
    this.history = history || globalEventHistory;
  }

  /**
   * 发布事件（重写以添加历史记录）
   */
  emit<T extends EventType>(eventType: T, data: DataByEvent<T>): boolean {
    // 记录到历史
    if (this.enableHistory) {
      this.history.record(eventType, data);
    }

    return super.emit(eventType, data);
  }

  /**
   * 启用/禁用历史记录
   */
  setHistoryEnabled(enabled: boolean): this {
    this.enableHistory = enabled;
    return this;
  }

  /**
   * 获取历史记录器
   */
  getHistory(): EventHistory {
    return this.history;
  }

  /**
   * 获取事件统计信息
   */
  getEventStats(): Record<EventType, number> {
    return this.history.getStats();
  }

  /**
   * 创建事件过滤器
   * 返回一个新的事件总线，只处理指定类型的事件
   */
  createFilter(eventTypes: EventType[]): EnhancedEventBus {
    const filteredBus = new EnhancedEventBus();
    const eventTypeSet = new Set(eventTypes);

    // 为指定的事件类型创建转发监听器
    for (const eventType of eventTypes) {
      this.on(eventType as any, (data: any) => {
        if (eventTypeSet.has(eventType)) {
          filteredBus.emit(eventType as any, data);
        }
      });
    }

    return filteredBus;
  }

  /**
   * 创建事件聚合器
   * 将多个事件聚合成一个事件
   */
  createAggregator<T extends EventType>(
    sourceEvents: EventType[],
    targetEvent: T,
    aggregateData: (
      events: Array<{ eventType: EventType; data: any }>
    ) => DataByEvent<T>,
    windowSize: number = 1
  ): this {
    const eventBuffer: Array<{
      eventType: EventType;
      data: any;
      timestamp: number;
    }> = [];

    for (const sourceEvent of sourceEvents) {
      this.on(sourceEvent as any, (data: any) => {
        eventBuffer.push({
          eventType: sourceEvent,
          data,
          timestamp: Game.time,
        });

        // 清理过期的事件
        const cutoff = Game.time - windowSize;
        while (eventBuffer.length > 0 && eventBuffer[0].timestamp < cutoff) {
          eventBuffer.shift();
        }

        // 如果缓冲区中有足够的事件，触发聚合事件
        if (eventBuffer.length > 0) {
          const aggregatedData = aggregateData(eventBuffer);
          this.emit(targetEvent, aggregatedData);
        }
      });
    }

    return this;
  }

  /**
   * 创建事件延迟器
   * 延迟指定时间后发布事件
   */
  emitDelayed<T extends EventType>(
    eventType: T,
    data: DataByEvent<T>,
    delay: number
  ): this {
    const targetTime = Game.time + delay;

    // 创建一个简单的定时器（在实际使用中可能需要更复杂的定时器系统）
    const checkTimer = () => {
      if (Game.time >= targetTime) {
        this.emit(eventType, data);
      } else {
        // 在实际应用中，这里应该使用更优雅的定时器机制
        setTimeout(checkTimer, 100);
      }
    };

    checkTimer();
    return this;
  }

  /**
   * 批量发布事件
   */
  emitBatch(events: Array<{ eventType: EventType; data: any }>): this {
    for (const { eventType, data } of events) {
      this.emit(eventType as any, data);
    }
    return this;
  }
}

/**
 * 全局增强事件总线实例
 */
export const globalEnhancedEventBus = new EnhancedEventBus();
