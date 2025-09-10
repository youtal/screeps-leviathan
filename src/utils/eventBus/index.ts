// 导出核心类和类型
export { EventBus } from './EventBus';
export { EnhancedEventBus, globalEnhancedEventBus } from './EnhancedEventBus';
export { EventHistory, globalEventHistory } from './EventHistory';
export {
  MiddlewareEventBus,
  loggingMiddleware,
  performanceMiddleware,
  errorCatchingMiddleware,
  createRateLimitMiddleware,
  createFilterMiddleware,
  createTransformMiddleware,
  createBatchMiddleware,
  EmitEvent,
  OnEvent,
} from './middleware';
export * from './types';

// 导出实用函数和全局实例
export {
  globalEventBus,
  emitEvent,
  onEvent,
  onceEvent,
  offEvent,
  ResourceEvents,
  CreepEvents,
  StructureEvents,
  RoomEvents,
  CombatEvents,
} from './utils';
