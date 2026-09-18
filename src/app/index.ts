/**
 * 文件摘要
 *
 * 模块角色：app 的统一入口，供游戏入口取得已组装的应用。
 *
 * 主要功能：导出框架实例和应用选用的插件描述。
 *
 * 实现过程：分别转发 runtime.ts 与 modules.ts 的导出，实例创建和插件定义仍由各自文件负责。
 *
 * 技术要点：导入本入口会执行应用装配，插件 setup 则留到首次 loop。
 * 本文件不另建缓存；global reset 后，所引用的应用实例也会重新创建。
 */
export * from './runtime';
export * from './modules';
