/**
 * 文件摘要
 *
 * 模块角色：core/taskScheduler 的公共入口，向 Runtime 提供工厂并发布构造选项类型。
 *
 * 主要功能：导出 createTaskScheduler 与其配置类型；调度、失败归属与公平性协议本身
 * 转发自 contracts/task，与其它 Core 模块的入口写法一致。
 *
 * 实现过程：只做转发，不创建实例、不读取 Game 或 Memory。
 *
 * 技术要点：TaskHost/TaskScheduler 等公共协议类型属于 contracts，业务代码应直接从
 * `@/contracts` 导入；这里的 `export type *` 只是为了让同时需要工厂和协议类型的调用方
 * （例如 Runtime 自身）可以从同一入口取得两者。
 */
export { createTaskScheduler } from './createTaskScheduler';
export type { TaskSchedulerOptions } from './createTaskScheduler';
export type * from '@/contracts/task';
