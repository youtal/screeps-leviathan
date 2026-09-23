/**
 * 文件摘要
 *
 * 模块角色：contracts 的统一类型入口，供 Core 与业务模块引用共同约定。
 *
 * 主要功能：汇总日志、环境、Runtime、Profiler、事件、错误、意图、插件、存储、
 * 任务调度协议，以及服务令牌的类型与创建函数。
 *
 * 实现过程：类型协议使用 export type 转发；defineService 是唯一在此发布的轻量运行时值，
 * 供能力模块在装载时建立一次令牌，不创建服务实例。
 *
 * 技术要点：除 defineService 外的导出均在编译时移除；具体服务仍由插件 setup 创建，
 * Framework 按 name 查表并执行生命周期约束，不由契约入口装配。
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
export type * from './task';
export type { ServiceToken } from './service';
export { defineService } from './service';
