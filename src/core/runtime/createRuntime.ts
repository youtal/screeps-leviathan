/**
 * 文件摘要：按单向依赖顺序组合全部 Core 能力，创建应用级 Root Runtime。
 *
 * core/runtime 的装配入口：创建 Logger 后依次组装 EventBus、MemoryManager、
 * Profiler 与 ErrorMapper，向 app 层提供完整 Root Runtime。它只做依赖组合，
 * 不管理 tick 生命周期或插件依赖（由 Framework 驱动），也不挂载或写回 Memory。
 *
 * 输入是可选的 RuntimeOptions；输出是 CoreRuntime，其中包含唯一 Core 实例及
 * createContext。后者按模块名得到共享 bus/profiler、绑定 memory 与独立 env。
 *
 * 状态与副作用：共享单例与默认 Profiler 统计都存放在本函数闭包中，随当前
 * global 生命周期存在，global reset 后由调用方重新装配；默认统计对象只驻留
 * heap，不会被序列化进 Memory，需要持久化时必须由宿主注入存储
 * 接口提供的访问器和标脏回调。
 */
import { createBus } from '@/core/eventBus';
import { createErrorMapper } from '@/core/errorMapper';
import { createLogging } from '@/core/logger';
import { createMemoryManager } from '@/core/memoryManager';
import { createProfiler } from '@/core/profiler';
import { DEFAULT_PROFILER_ENABLE } from '@/setting';
import { createEnvMethods } from './env';
import type {
  CoreRuntime,
  ModuleContext,
  ModuleContextOptions,
} from '@/contracts';
import type { RuntimeOptions } from './types';

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
export const createRuntime = (options: RuntimeOptions = {}): CoreRuntime => {
  /**
   * 日志工厂只解析一次：注入用于测试收集输出或复用已有配置，缺省时按项目
   * 默认等级创建一个独立工厂。同一 Runtime 派生的所有消费者共享它，
   * 因此日志端口与邮件策略在整个运行期内一致。
   */
  const logging = options.logging ?? createLogging();
  /**
   * 总线只解析一次：注入用于测试替换或复用已有总线，缺省时新建一条独立
   * 总线，让不同 root runtime 的订阅互不干扰。总线自己的诊断日志走同一个
   * 日志工厂，避免内核组件各自持有第二套日志配置。
   */
  const bus = options.bus ?? createBus(logging);
  /**
   * MemoryManager 位于 logging 之后创建，只消费已经存在的日志契约实例。
   * 显式注入主要服务平台测试；默认实例直到 begin 才读取 RawMemory。
   */
  const memory = options.memory ?? createMemoryManager({ logging });
  const getGame = options.getGame ?? (() => Game);
  /**
   * 默认 Profiler 统计的落点：一个只存在于本闭包 heap 的普通对象。
   *
   * 独立 Runtime 没有 Framework 的提交边界，无法判断何时该把统计写回 Memory，
   * 因此默认不触碰全局 Memory，避免绕开统一持久化协议；代价是 global reset
   * 后统计清零。需要跨 global reset 保留时必须注入 getProfilerMemory 与
   * markProfilerMemoryDirty，由调用者决定存储位置与写回时机。
   *
   * 该对象被所有派生上下文共享：Profiler 计时路径会在其中原地累加每个 label
   * 的 totalTime/selfTime/calls，报告与 reset 也直接读写同一份数据。
   */
  const heapProfilerMemory = {};
  /**
   * 用 `=== undefined` 而非 `??` 判断：显式传入 `null` 表示“本次运行不使用
   * Profiler”，与“未提供、需要默认创建”是两种语义。
   *
   * 默认开关取自 setting，默认关闭，避免未启用时也承担每次包裹调用的取样成本。
   * Profiler 的环境以 'Profiler' 为日志前缀单独创建（共用 Runtime 的日志工厂），
   * 使其诊断日志与业务模块区分开；createProfiler 拿不到统计对象时会返回 null，
   * 因此调用方按可空处理。
   */
  const profiler =
    options.profiler === undefined
      ? createProfiler({
          env: createEnvMethods('Profiler', logging, {}, undefined, getGame),
          getMemory: options.getProfilerMemory ?? (() => heapProfilerMemory),
          markMemoryDirty: options.markProfilerMemoryDirty,
          enable: options.enableProfiler ?? DEFAULT_PROFILER_ENABLE,
        })
      : options.profiler;
  /** ErrorMapper 只接收已创建的日志实例；其计时适配由 Framework 在消费时设置。 */
  const errorMapper =
    options.errorMapper ??
    createErrorMapper(logging, options.loadSourceMap, options.report);

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
    createContext,
  };
};
