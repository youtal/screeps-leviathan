import { EventType, DataByEvent } from './types';

/**
 * 事件历史记录项
 */
export interface EventHistoryItem {
  eventType: EventType;
  data: any;
  timestamp: number;
  gameTime: number;
}

/**
 * 事件历史记录器
 */
export class EventHistory {
  private history: EventHistoryItem[] = [];
  private maxHistory: number = 1000;

  /**
   * 记录事件
   */
  record<T extends EventType>(eventType: T, data: DataByEvent<T>): void {
    const item: EventHistoryItem = {
      eventType,
      data,
      timestamp: Date.now(),
      gameTime: Game.time,
    };

    this.history.push(item);

    // 保持历史记录在限制范围内
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * 获取历史记录
   */
  getHistory(eventType?: EventType, limit?: number): EventHistoryItem[] {
    let filtered = this.history;

    if (eventType) {
      filtered = this.history.filter((item) => item.eventType === eventType);
    }

    if (limit) {
      filtered = filtered.slice(-limit);
    }

    return [...filtered];
  }

  /**
   * 获取最近的事件
   */
  getRecent(eventType?: EventType, count: number = 10): EventHistoryItem[] {
    return this.getHistory(eventType, count);
  }

  /**
   * 获取指定游戏时间范围内的事件
   */
  getByGameTimeRange(startTime: number, endTime: number): EventHistoryItem[] {
    return this.history.filter(
      (item) => item.gameTime >= startTime && item.gameTime <= endTime
    );
  }

  /**
   * 清除历史记录
   */
  clear(): void {
    this.history = [];
  }

  /**
   * 设置最大历史记录数量
   */
  setMaxHistory(max: number): void {
    this.maxHistory = max;
    if (this.history.length > max) {
      this.history = this.history.slice(-max);
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): Record<EventType, number> {
    const stats: Record<string, number> = {};

    for (const item of this.history) {
      stats[item.eventType] = (stats[item.eventType] || 0) + 1;
    }

    return stats as Record<EventType, number>;
  }

  /**
   * 导出历史记录（用于持久化）
   */
  export(): EventHistoryItem[] {
    return [...this.history];
  }

  /**
   * 导入历史记录（用于恢复）
   */
  import(history: EventHistoryItem[]): void {
    this.history = [...history];
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }
}

/**
 * 全局事件历史记录器实例
 */
export const globalEventHistory = new EventHistory();
