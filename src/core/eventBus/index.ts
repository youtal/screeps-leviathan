/**
 * 文件摘要：汇总导出 EventBus 工厂、事件常量以及公共类型协议。
 *
 * 业务模块应从该入口导入总线能力，避免依赖模块内部文件结构。
 */
export { eventCategory, eventList } from './constants';
export { createBus } from './createBus';
export * from './types';
