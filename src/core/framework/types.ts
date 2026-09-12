/**
 * 文件摘要：保存 Framework 的 heap 健康状态；公共接口由 contracts 发布。
 * 仅维护模块内部类型及契约兼容出口，不创建运行时状态或调用宿主。
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
