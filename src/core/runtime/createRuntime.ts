/**
 * 文件摘要
 *
 * 模块角色：core/runtime 的基础能力装配实现，是 Core 同级模块具体工厂的集中调用处。
 *
 * 主要功能：创建或接受日志、总线、存储、Profiler、错误映射和任务调度实例，返回完整
 * CoreRuntime 与上下文工厂。
 *
 * 实现过程：先按 RuntimeOverrides 选择已有实例，未替换的能力按分组配置创建；
 * 将日志工厂传给消费者，createContext 为模块派生日志环境、
 * 绑定存储申请入口与任务调度入口，同时复用同一总线和 Profiler。
 *
 * 技术要点：Game 通过函数延迟获取，不跨 tick 缓存；配置 profiler: false 不创建统计器，
 * 实例替换优先于配置，overrides.profiler: null 明确禁用。
 * 默认统计表保存在 Runtime 内存中；实例跨 tick 复用，global reset 后重建，持久分区由 MemoryManager 恢复。
 */
import { createBus } from '@/core/eventBus';
import { createErrorMapper } from '@/core/errorMapper';
import { createLogging } from '@/core/logger';
import { createMemoryManager } from '@/core/memoryManager';
import { createProfiler } from '@/core/profiler';
import { createTaskScheduler } from '@/core/taskScheduler';
import { DEFAULT_PROFILER_ENABLE } from '@/setting';
import { createEnvMethods } from './env';
import type {
  CoreRuntime,
  ModuleContext,
  ModuleContextOptions,
} from '@/contracts';
import type { RuntimeOptions, RuntimeOverrides } from './types';

/**
 * 创建当前 AI 的 root runtime。
 *
 * 返回对象持有框架级单例：
 * - logging：日志工厂，统一等级、输出端口与邮件策略，并注入模块 env 与总线。
 * - bus：模块通信总线。
 * - profiler：性能统计器，可通过 options 替换、禁用或配置。
 *
 * app 层只需要调用一次 createRuntime，然后用 `runtime.createContext` 为各模块
 * 派生 ModuleContext。这样模块可以共享核心单例，又拥有自己的日志前缀。
 * 工厂自身不缓存派生结果：同一 moduleName 重复调用会得到新的 env 对象。
 */
export const createRuntime = (
  options: RuntimeOptions = {},
  overrides: RuntimeOverrides = {}
): CoreRuntime => {
  /**
   * 日志工厂只解析一次：测试替身优先，否则由 logging 配置创建；省略配置时按
   * 项目默认等级创建。同一 Runtime 派生的所有消费者共享它，
   * 因此日志端口与邮件策略在整个运行期内一致。
   */
  const logging = overrides.logging ?? createLogging(options.logging);
  /**
   * 总线只解析一次：overrides 用于测试替换，缺省时新建一条独立
   * 总线，让不同 root runtime 的订阅互不干扰。总线自己的诊断日志走同一个
   * 日志工厂，避免内核组件各自持有第二套日志配置。
   */
  const bus = overrides.bus ?? createBus(logging);
  const getGame = options.platform?.getGame ?? (() => Game);
  /**
   * MemoryManager 位于 logging 之后创建，只消费已经存在的日志契约实例。
   * overrides.memory 服务测试或特殊宿主；默认实例直到 begin 才读取 RawMemory。
   * tick 来源由共享 getGame 端口派生：Framework 以 getGame().time 调用 begin/end，
   * 管理器以同一来源判定真实 tick，注入模拟 Game 时两者不会分叉。
   */
  const memory =
    overrides.memory ??
    createMemoryManager({
      ...options.memoryManager,
      getTick: () => getGame().time,
      logging,
    });
  /**
   * 默认 Profiler 统计的落点：一个只存在于本闭包 heap 的普通对象。
   *
   * 独立 Runtime 没有 Framework 的提交边界，无法判断何时该把统计写回 Memory，
   * 因此默认不触碰全局 Memory，避免绕开统一持久化协议；代价是 global reset
   * 后统计清零。需要其它落点时由 ProfilerOptions.storage 提供完整存储端口，
   * Runtime 顶层不再暴露成对的底层回调。
   *
   * 该对象被所有派生上下文共享：Profiler 计时路径会在其中原地累加每个 label
   * 的 totalTime/selfTime/calls，报告与 reset 也直接读写同一份数据。
   */
  const heapProfilerMemory = {};
  /**
   * overrides.profiler 的 null 与 options.profiler 的 false 都表示禁用；前者服务
   * 测试实例替换，后者是生产配置。undefined 才表示由 Runtime 创建默认实例。
   *
   * 默认开关取自 setting，默认关闭，避免未启用时也承担每次包裹调用的取样成本。
   * Profiler 的环境以 'Profiler' 为日志前缀单独创建（共用 Runtime 的日志工厂），
   * 使其诊断日志与业务模块区分开；createProfiler 拿不到统计对象时会返回 null，
   * 因此调用方按可空处理。
   */
  const profiler =
    overrides.profiler !== undefined
      ? overrides.profiler
      : options.profiler === false
        ? null
        : createProfiler({
            env: createEnvMethods('Profiler', logging, {}, undefined, getGame),
            storage: options.profiler?.storage ?? {
              getMemory: () => heapProfilerMemory,
            },
            enable: options.profiler?.enabled ?? DEFAULT_PROFILER_ENABLE,
          });
  /** ErrorMapper 只接收已创建的日志实例；其计时适配由 Framework 在消费时设置。 */
  const errorMapper =
    overrides.errorMapper ?? createErrorMapper(logging, options.errorMapper);
  /**
   * TaskScheduler 排在 errorMapper 之后创建：它依赖 Logger（自身诊断）、ErrorMapper
   * （任务失败的堆栈捕获与映射）、Profiler（任务分片计时）和 MemoryHost（跨 global 的重启
   * 记录，只经 MemoryHost 契约申请分区），四者此时都已就绪。不依赖 EventBus。
   */
  const tasks =
    overrides.tasks ??
    createTaskScheduler({
      ...options.taskScheduler,
      getGame,
      logging,
      errorMapper,
      profiler,
      memory,
    });

  const createContext = (
    moduleName: string,
    moduleOptions: ModuleContextOptions = {}
  ): ModuleContext => {
    /**
     * 每次派生模块上下文时重新创建 env。
     *
     * bus/profiler/logging 共享 root 单例；env 则按 moduleName 独立创建，让日志
     * 能准确标识来源模块，也允许不同模块使用不同日志等级与邮件覆盖。
     *
     * 这里刻意不缓存派生结果：env 只包含无状态的 Game 访问方法和一个 logger，
     * 创建成本极低，缓存反而会让闭包长期持有已不再使用的日志配置。
     */
    const context: ModuleContext = {
      bus,
      env: createEnvMethods(
        moduleName,
        logging,
        moduleOptions.log,
        moduleOptions.notify,
        getGame
      ),
      profiler,
      memory: memory.bind(moduleName),
      tasks: tasks.bind(moduleName),
    };
    return context;
  };

  return {
    getGame,
    logging,
    bus,
    memory,
    profiler,
    errorMapper,
    tasks,
    createContext,
  };
};
