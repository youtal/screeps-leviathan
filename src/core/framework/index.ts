/**
 * 文件摘要：导出 Framework 工厂、同步错误映射器和公共插件协议。
 *
 * app 负责选择插件并创建实例，框架实例 loop 可直接用作 Screeps 主循环。
 * 本文件仅整理出口，不创建实例或访问 Game/Memory；内部仲裁和注册组件不作为公共出口。
 *
 * 所属模块：core/framework 的公共入口（barrel），被 src/app/runtime.ts、src/core/index.ts
 * 以及业务模块的类型导入引用；出口分三类：createFramework 工厂（组合内核并返回 loop 与管理
 * 方法）、createErrorMapper（可独立复用的同步堆栈映射）、types.ts 的插件协议与公共数据类型。
 * 调用方以 FrameworkOptions 与插件描述为输入创建实例，本文件自身没有运行时状态和副作用。
 * 聚合导出会连带加载 createFramework 依赖的 EventBus/Profiler/Runtime 模块，但初始化副作用
 * 仍只在调用工厂时发生；Screeps 打包为单个 main.js，多出口不产生额外传输成本。
 * cpuGovernor/intentBroker/pluginRegistry 刻意不导出：
 * 它们的契约只在内核内部稳定，暴露给业务会限制后续重构（需要时经 Context 能力访问）。
 */
// 导出语句顺序不影响求值（ES 模块的导出都会被提升），此处只按阅读顺序排列，不表达依赖关系。
// types.ts 只含类型声明，运行时等价于空导出，仅提供编译期协议。
export * from './errorMapper';
export * from './types';
// 只导出工厂而非实例：单例由 app 层按部署目标决定，框架不隐式创建全局状态。
export { createFramework } from './createFramework';
