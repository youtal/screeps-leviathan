/**
 * 文件摘要：汇总导出 EventBus 工厂、事件常量以及公共类型协议。
 *
 * core/eventBus 的公共出口：业务模块与 Framework 都应从该入口导入总线能力，
 * 避免依赖模块内部文件结构。导出内容对应模块的三个层次 —— contracts 的类型
 * 协议、constants.ts 的事件常量、createBus 的运行时工厂。
 *
 * 本文件不创建总线实例：createBus 只是工厂，实例由 createRuntime 或 Framework
 * 在自己的装配阶段创建并共享。因此导入本入口不会注册订阅、不会写入 Memory 或
 * Game，也不持有任何跨 tick 状态，global reset 后行为不变。
 */
export { eventCategory, eventList } from './constants';
export { createBus } from './createBus';
/**
 * 公共类型协议整体透出：contracts 只包含类型与接口，编译后不会留下代码，后续新增
 * 事件相关类型也无须在这里重复登记。
 */
export type * from '@/contracts/eventBus';
export type * from '@/contracts/events';
