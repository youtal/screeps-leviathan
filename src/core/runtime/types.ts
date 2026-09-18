/**
 * 文件摘要
 *
 * 模块角色：core/runtime 的装配类型定义，约定调用方如何配置或替换基础能力。
 *
 * 主要功能：声明分组的 RuntimeOptions、平台访问选项与 RuntimeOverrides，并转发模块上下文类型。
 *
 * 实现过程：用各模块的创建选项描述配置，用 contracts 的接口描述可替换实例；
 * MemoryManager 配置通过 Omit 排除 logging，因为该依赖必须由 Runtime 统一提供。
 *
 * 技术要点：第二参数的实例替换优先于第一参数的配置；Profiler 配置允许 false，替换项允许 null。
 * 本文件只做编译期检查，不执行配置回调、不创建实例，也不保存跨 tick 状态。
 */
import type {
  Bus,
  ErrorMapper,
  LoggerFactory,
  MemoryHost,
  Profiler,
  LoggingOptions,
} from '@/contracts';
import type { ErrorMapperOptions } from '@/core/errorMapper';
import type { MemoryManagerOptions } from '@/core/memoryManager';
import type { ProfilerOptions } from '@/core/profiler';

export type {
  Wrap,
  HasWrap,
  EnvMethods,
  EnvContext,
  ModuleContextOptions,
  ModuleContext,
  CreateModuleContext,
} from '@/contracts';

/** Runtime 与 Framework 共用的平台入口；访问器必须在调用时返回当 tick 的 Game。 */
export interface RuntimePlatformOptions {
  getGame?: () => Game;
}

/**
 * 创建 Root Runtime 的生产配置。
 *
 * 每个字段归拥有该行为的模块解释：Runtime 只负责依赖排序和转交，不把 Profiler、
 * ErrorMapper 或 MemoryManager 的配置重新发布成一组平铺字段。false 明确禁用
 * Profiler；省略 profiler 则按项目默认开关创建 heap 统计实例。
 */
export interface RuntimeOptions {
  platform?: RuntimePlatformOptions;
  logging?: LoggingOptions;
  memoryManager?: Omit<MemoryManagerOptions, 'logging'>;
  profiler?: ProfilerOptions | false;
  errorMapper?: ErrorMapperOptions;
}

/**
 * 测试或特殊宿主使用的实例替换入口。
 *
 * 替换项与生产配置分离，防止调用者误把“模块实例”当作模块配置。Runtime 仍然
 * 负责选择最终实例并向后序模块注入；普通 App 不应使用该参数建立第二条装配路径。
 * profiler 允许显式 null，用于验证关闭观测时 Framework 的降级行为。
 */
export interface RuntimeOverrides {
  logging?: LoggerFactory;
  bus?: Bus;
  memory?: MemoryHost;
  profiler?: Profiler | null;
  errorMapper?: ErrorMapper;
}
