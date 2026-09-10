/**
 * 文件摘要：导出 Framework 实例的 loop，作为 Screeps 每 tick 的主循环。
 * app 层完成插件选择，框架依次驱动前处理、决策提交与后处理。
 * loop 通过闭包访问实例，不依赖 this，游戏可直接调用导出函数。
 *
 * 本文件同时是 Rollup 的打包入口（rollup.config.mjs 的 input），引擎最终只看到
 * 这里的 `loop` 导出。顶层 import 在模块求值时创建 Framework 实例，所以脚本每次
 * 加载（包括 global reset 后的重新加载）都会得到新的实例与新 loop；这里取方法
 * 引用而不是再包一层调用，是为了不引入额外的每 tick 开销和 this 语义。
 *
 * 入口不重复实现初始化与收尾：Memory 挂载、插件 setup、tickBegin/tickExecute/
 * commit 以及 tickEnd 写回都在 framework.loop 内部完成。该 loop 不可重入，运行中
 * 再次调用会抛错，同一 tick 重复调用则直接返回，这些语义同样由实例维护。
 */
import { framework } from './app';

/** Screeps 每 tick 调用此导出；不在入口重复创建框架，初始化与后处理均交由实例管理。 */
export const loop = framework.loop;
