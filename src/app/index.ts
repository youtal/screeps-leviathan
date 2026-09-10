/**
 * 文件摘要：作为 App 层统一出口，暴露 Framework 实例和服务插件描述。
 *
 * core 与 modules 提供工厂和协议；app 创建 Framework 单例，服务实例在
 * 首次 loop 的 setup 中创建。调用方通过本入口取得可直接导出的 loop。
 *
 * 这里是当前 AI 组合根的对外门户：`src/index.ts` 只从本入口取 framework，
 * 新增业务模块时在 modules.ts 声明插件描述、在 runtime.ts 注册，不需要改动本文件。
 * 两条 `export *` 会在求值时执行被再导出的模块（runtime.ts 又先执行 modules.ts），
 * 所以“导入本入口”本身就完成了实例创建与插件注册；但两者都不读取 Memory、
 * 不访问 Game，真正的挂载与 setup 在第一次 loop 内发生。global reset 后模块图
 * 重新求值，会得到全新的实例和注册队列。
 */
export * from './runtime';
export * from './modules';
