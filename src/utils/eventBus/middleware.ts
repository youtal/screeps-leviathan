import { EventType, DataByEvent } from './types';
import { EventBus } from './EventBus';

/**
 * 事件中间件函数类型
 */
export type EventMiddleware<T extends EventType = EventType> = (
  eventType: T,
  data: DataByEvent<T>,
  next: () => void
) => void;

/**
 * 支持中间件的事件总线
 */
export class MiddlewareEventBus extends EventBus {
  private middlewares: EventMiddleware[] = [];

  /**
   * 添加中间件
   */
  use(middleware: EventMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * 移除中间件
   */
  removeMiddleware(middleware: EventMiddleware): this {
    const index = this.middlewares.indexOf(middleware);
    if (index > -1) {
      this.middlewares.splice(index, 1);
    }
    return this;
  }

  /**
   * 发布事件（通过中间件链）
   */
  emit<T extends EventType>(eventType: T, data: DataByEvent<T>): boolean {
    if (this.middlewares.length === 0) {
      return super.emit(eventType, data);
    }

    let index = 0;
    const runMiddleware = () => {
      if (index >= this.middlewares.length) {
        return super.emit(eventType, data);
      }

      const middleware = this.middlewares[index++];
      middleware(eventType as any, data as any, runMiddleware);
      return true; // 中间件链至少执行了
    };

    return runMiddleware();
  }
}

/**
 * 日志中间件
 */
export const loggingMiddleware: EventMiddleware = (eventType, data, next) => {
  console.log(`[EventBus] 发布事件: ${eventType}`, data);
  next();
};

/**
 * 性能监控中间件
 */
export const performanceMiddleware: EventMiddleware = (
  eventType,
  data,
  next
) => {
  const start = Date.now();
  next();
  const duration = Date.now() - start;

  if (duration > 5) {
    // 如果处理时间超过5ms
    console.warn(`[EventBus] 事件 ${eventType} 处理耗时 ${duration}ms`);
  }
};

/**
 * 错误捕获中间件
 */
export const errorCatchingMiddleware: EventMiddleware = (
  eventType,
  data,
  next
) => {
  try {
    next();
  } catch (error) {
    console.error(`[EventBus] 事件 ${eventType} 处理出错:`, error);
    // 可以选择是否重新抛出错误
    // throw error;
  }
};

/**
 * 频率限制中间件工厂
 */
export function createRateLimitMiddleware(
  maxEventsPerTick: number = 100
): EventMiddleware {
  let currentTick = Game.time;
  let eventCount = 0;

  return (eventType, data, next) => {
    if (Game.time !== currentTick) {
      currentTick = Game.time;
      eventCount = 0;
    }

    if (eventCount >= maxEventsPerTick) {
      console.warn(`[EventBus] 事件频率限制: 跳过事件 ${eventType}`);
      return;
    }

    eventCount++;
    next();
  };
}

/**
 * 事件过滤中间件工厂
 */
export function createFilterMiddleware(
  predicate: (eventType: EventType, data: any) => boolean
): EventMiddleware {
  return (eventType, data, next) => {
    if (predicate(eventType, data)) {
      next();
    }
  };
}

/**
 * 事件转换中间件工厂
 */
export function createTransformMiddleware<T extends EventType>(
  transformer: (eventType: T, data: DataByEvent<T>) => DataByEvent<T>
): EventMiddleware<T> {
  return (eventType, data, next) => {
    const transformedData = transformer(eventType, data);
    // 这里需要修改原始数据，因为我们不能改变 next 的参数
    Object.assign(data, transformedData);
    next();
  };
}

/**
 * 批量处理中间件工厂
 */
export function createBatchMiddleware(batchSize: number = 10): EventMiddleware {
  const batch: Array<{ eventType: EventType; data: any }> = [];

  return (eventType, data, next) => {
    batch.push({ eventType, data });

    if (batch.length >= batchSize) {
      // 批量处理
      for (const item of batch) {
        next();
      }
      batch.length = 0;
    }
  };
}

/**
 * 事件装饰器：自动发布事件
 */
export function EmitEvent<T extends EventType>(
  eventType: T,
  dataFactory: (...args: any[]) => DataByEvent<T>,
  eventBus?: EventBus
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const bus = eventBus || new EventBus();

    descriptor.value = function (...args: any[]) {
      const result = originalMethod.apply(this, args);

      try {
        const data = dataFactory.apply(this, args);
        bus.emit(eventType, data);
      } catch (error) {
        console.error(`[EventBus] 装饰器发布事件 ${eventType} 失败:`, error);
      }

      return result;
    };

    return descriptor;
  };
}

/**
 * 事件装饰器：监听事件
 */
export function OnEvent<T extends EventType>(
  eventType: T,
  eventBus?: EventBus
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const bus = eventBus || new EventBus();
    const handler = descriptor.value;

    // 在类实例化时注册监听器
    if (!target.constructor.__eventListeners) {
      target.constructor.__eventListeners = [];
    }

    target.constructor.__eventListeners.push({
      eventType,
      handler,
      propertyKey,
    });

    // 修改构造函数以自动注册监听器
    const originalConstructor = target.constructor;
    if (!originalConstructor.__eventBusPatched) {
      const newConstructor = function (...args: any[]) {
        const instance = originalConstructor.apply(this, args);

        // 注册所有事件监听器
        if (originalConstructor.__eventListeners) {
          for (const {
            eventType,
            handler,
            propertyKey,
          } of originalConstructor.__eventListeners) {
            bus.on(eventType, handler.bind(this));
          }
        }

        return instance;
      };

      newConstructor.prototype = originalConstructor.prototype;
      newConstructor.__eventBusPatched = true;
      newConstructor.__eventListeners = originalConstructor.__eventListeners;

      return newConstructor as any;
    }

    return descriptor;
  };
}
