/**
 * 文件摘要：汇总跨模块公共协议；业务内部类型不得经此发布。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
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
