/**
 * 文件摘要
 *
 * 模块角色：core/framework 的类型汇集处，连接框架内部健康记录与公共插件协议。
 *
 * 主要功能：声明 PluginHealth，并转发框架、插件、错误、CPU 和意图类型。
 *
 * 实现过程：用累计失败数、连续失败数和 circuitOpen 标记描述单插件健康状态；
 * 公共类型从 contracts 对应文件转发，避免在实现目录重新定义相同协议。
 *
 * 技术要点：这里只定义数据形状，不累计失败或触发暂停；健康记录由 createFramework 保存和更新。
 * 类型在编译后移除，不产生缓存或游戏访问。
 */
export type {
  Framework,
  FrameworkOptions,
  FrameworkStatus,
  PluginManifest,
  PluginContext,
  LeviathanPlugin,
} from '@/contracts/plugin';
export type {
  Phase,
  PluginFailure,
  ExecutionResult,
} from '@/contracts/errorMapper';
export type { CpuBudget, GameIntent, IntentReceipt } from '@/contracts/intent';
/** 同实例跨 tick 累计，global reset 清空；不读写 Memory。 */
export interface PluginHealth {
  failures: number;
  consecutiveFailures: number;
  circuitOpen: boolean;
}
