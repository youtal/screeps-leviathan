/**
 * 文件摘要：导出 Framework 工厂、同步错误映射器和公共插件协议。
 *
 * app 负责选择插件并创建实例，框架实例 loop 可直接用作 Screeps 主循环。
 * 本文件仅整理出口，不创建实例或访问 Game/Memory；内部仲裁、注册和存储组件不作为公共出口。
 */
export * from './errorMapper';
export * from './types';
export { createFramework } from './createFramework';
