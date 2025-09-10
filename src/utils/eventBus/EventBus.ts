import { EventType, DataByEvent, ExtractBase } from './types';

/**
 * 事件监听器函数类型
 */
type EventListener<T extends EventType> = (data: DataByEvent<T>) => void;

/**
 * 事件总线类 - 实现发布订阅模式
 */
export class EventBus {
  private listeners: Map<EventType, Set<EventListener<any>>> = new Map();
  private onceListeners: Map<EventType, Set<EventListener<any>>> = new Map();
  private maxListeners: number = 100;

  /**
   * 订阅事件
   * @param eventType 事件类型
   * @param listener 监听器函数
   */
  on<T extends EventType>(eventType: T, listener: EventListener<T>): this {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }

    const listeners = this.listeners.get(eventType)!;
    if (listeners.size >= this.maxListeners) {
      console.warn(
        `EventBus: 事件 ${eventType} 的监听器数量已达到最大值 ${this.maxListeners}`
      );
    }

    listeners.add(listener);
    return this;
  }

  /**
   * 订阅事件（只触发一次）
   * @param eventType 事件类型
   * @param listener 监听器函数
   */
  once<T extends EventType>(eventType: T, listener: EventListener<T>): this {
    if (!this.onceListeners.has(eventType)) {
      this.onceListeners.set(eventType, new Set());
    }

    const onceListeners = this.onceListeners.get(eventType)!;
    onceListeners.add(listener);
    return this;
  }

  /**
   * 取消订阅事件
   * @param eventType 事件类型
   * @param listener 监听器函数
   */
  off<T extends EventType>(eventType: T, listener: EventListener<T>): this {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(eventType);
      }
    }

    const onceListeners = this.onceListeners.get(eventType);
    if (onceListeners) {
      onceListeners.delete(listener);
      if (onceListeners.size === 0) {
        this.onceListeners.delete(eventType);
      }
    }

    return this;
  }

  /**
   * 发布事件
   * @param eventType 事件类型
   * @param data 事件数据
   */
  emit<T extends EventType>(eventType: T, data: DataByEvent<T>): boolean {
    let hasListeners = false;

    // 触发普通监听器
    const listeners = this.listeners.get(eventType);
    if (listeners && listeners.size > 0) {
      hasListeners = true;
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          console.error(`EventBus: 事件 ${eventType} 的监听器执行出错:`, error);
        }
      }
    }

    // 触发一次性监听器
    const onceListeners = this.onceListeners.get(eventType);
    if (onceListeners && onceListeners.size > 0) {
      hasListeners = true;
      for (const listener of onceListeners) {
        try {
          listener(data);
        } catch (error) {
          console.error(
            `EventBus: 事件 ${eventType} 的一次性监听器执行出错:`,
            error
          );
        }
      }
      // 清除一次性监听器
      this.onceListeners.delete(eventType);
    }

    return hasListeners;
  }

  /**
   * 移除指定事件的所有监听器
   * @param eventType 事件类型
   */
  removeAllListeners(eventType?: EventType): this {
    if (eventType) {
      this.listeners.delete(eventType);
      this.onceListeners.delete(eventType);
    } else {
      this.listeners.clear();
      this.onceListeners.clear();
    }
    return this;
  }

  /**
   * 获取指定事件的监听器数量
   * @param eventType 事件类型
   */
  listenerCount(eventType: EventType): number {
    const listeners = this.listeners.get(eventType);
    const onceListeners = this.onceListeners.get(eventType);
    return (listeners?.size || 0) + (onceListeners?.size || 0);
  }

  /**
   * 获取所有事件类型
   */
  eventNames(): EventType[] {
    const allEvents = new Set<EventType>();
    for (const eventType of this.listeners.keys()) {
      allEvents.add(eventType);
    }
    for (const eventType of this.onceListeners.keys()) {
      allEvents.add(eventType);
    }
    return Array.from(allEvents);
  }

  /**
   * 设置最大监听器数量
   * @param n 最大数量
   */
  setMaxListeners(n: number): this {
    this.maxListeners = n;
    return this;
  }

  /**
   * 获取最大监听器数量
   */
  getMaxListeners(): number {
    return this.maxListeners;
  }
}
