/**
 * 文件摘要：导出 Framework 实例的 loop，作为 Screeps 每 tick 的主循环。
 * app 层完成插件选择，框架依次驱动前处理、决策提交与后处理。
 * loop 通过闭包访问实例，不依赖 this，游戏可直接调用导出函数。
 */
import { framework } from './app';

/** Screeps 每 tick 调用此导出；不在入口重复创建框架，初始化与后处理均交由实例管理。 */
export const loop = framework.loop;
