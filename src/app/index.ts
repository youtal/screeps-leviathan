/**
 * 文件摘要：作为 App 层统一出口，暴露 Framework 实例和服务插件描述。
 *
 * core 与 modules 提供工厂和协议；app 创建 Framework 单例，服务实例在
 * 首次 loop 的 setup 中创建。调用方通过本入口取得可直接导出的 loop。
 */
export * from './runtime';
export * from './modules';
