/**
 * 文件摘要
 *
 * 模块角色：contracts 的统一类型入口，供 Core 与业务模块引用共同约定。
 *
 * 主要功能：汇总日志、环境、Runtime、Profiler、事件、错误、意图、插件和存储协议。
 *
 * 实现过程：逐项使用 export type 转发各协议文件，让调用方从同一入口取得接口与类型。
 *
 * 技术要点：这里只发布类型，不导入具体工厂，也不创建实例或缓存；类型导出在编译时移除。
 * 运行时行为由实现这些接口的模块负责，新增协议须在此明确加入导出。
 */
export type * from './logging';
export type * from './environment';
export type * from './runtime';
export type * from './profiler';
export type * from './eventBus';
export type * from './events';
export type * from './errorMapper';
export type * from './intent';
export type * from './plugin';
export type * from './memory';
