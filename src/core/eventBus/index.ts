/**
 * 文件摘要
 *
 * 模块角色：core/eventBus 的公共入口，整理总线实现、事件常量和类型的导出。
 *
 * 主要功能：提供 createBus、eventCategory、eventList，以及事件作用域与载荷类型。
 *
 * 实现过程：工厂和常量分别来自 createBus.ts 与 constants.ts，公共协议从 contracts 转发。
 *
 * 技术要点：导入时会建立事件常量，但不创建总线或登记订阅；订阅状态归工厂实例所有。
 * Core 同级模块通过契约接收总线，生产实例由 Runtime 创建。
 */
export { eventCategory, eventList } from './constants';
export { createBus } from './createBus';
/**
 * 公共类型协议整体透出：contracts 只包含类型与接口，编译后不会留下代码，后续新增
 * 事件相关类型也无须在这里重复登记。
 */
export type * from '@/contracts/eventBus';
export type * from '@/contracts/events';
