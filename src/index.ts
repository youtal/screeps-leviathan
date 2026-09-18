/**
 * 文件摘要
 *
 * 模块角色：项目的游戏入口，连接 Screeps 的每 tick 调用与 app 创建的框架实例。
 *
 * 主要功能：对外提供引擎要求的 loop 函数。
 *
 * 实现过程：从 app 取得 framework，将其 loop 方法直接导出，不另加一层调用包装。
 *
 * 技术要点：导入 app 会创建应用实例并登记插件；插件初始化和游戏访问由 loop 驱动。
 * 实例在同一 global 生命周期内复用，global reset 后随模块重新加载而重建。
 */
import { framework } from './app';

/** Screeps 每 tick 调用此导出；不在入口重复创建框架，初始化与后处理均交由实例管理。 */
export const loop = framework.loop;
