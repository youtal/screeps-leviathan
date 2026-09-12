/**
 * 文件摘要：组合 EventBus、Profiler 与环境适配器，创建应用级模块上下文工厂。
 *
 * core/runtime 的装配入口：向下复用 eventBus 与 profiler，向上为 app 层提供
 * “创建一次 root runtime，再按模块名派生上下文”的组合方式。它只做依赖组合，
 * 不管理 tick 生命周期或插件依赖（由 Framework 驱动），也不挂载或写回 Memory。
 *
 * 输入是可选的 RuntimeOptions（总线、Profiler、统计存储访问器与标脏回调、
 * 初始开关）；输出是 CreateModuleContext —— 传入模块名与日志选项即可得到
 * ModuleContext（共享 bus/profiler、独立 env）。
 *
 * 状态与副作用：共享单例与默认 Profiler 统计都存放在本函数闭包中，随当前
 * global 生命周期存在，global reset 后由调用方重新装配；默认统计对象只驻留
 * heap，不会被序列化进 Memory，需要持久化时必须由宿主注入存储
 * 接口提供的访问器和标脏回调。
 */
import { createBus } from '@/core/eventBus';
import { createProfiler } from '@/core/profiler';
import { DEFAULT_PROFILER_ENABLE } from '@/setting';
import { createEnvMethods } from './env';
import type {
  CreateModuleContext,
  ModuleContext,
  ModuleContextOptions,
} from '@/contracts';
import type { RuntimeOptions } from './types';

/**
 * 创建当前 AI 的 root runtime。
 *
 * 它不会直接返回 root context，而是返回一个 createContext 函数。
 * root runtime 内部持有框架级单例：
 * - bus：模块通信总线。
 * - profiler：性能统计器，可通过 options 替换、禁用或配置。
 *
 * app 层只需要调用一次 createRuntime，然后用返回的 createContext 为各模块
 * 派生 ModuleContext。这样模块可以共享核心单例，又拥有自己的日志前缀。
 * 工厂自身不缓存派生结果：同一 moduleName 重复调用会得到新的 env 对象。
 */
export const createRuntime = (
  options: RuntimeOptions = {}
): CreateModuleContext => {
  /**
   * 总线只解析一次：注入用于测试替换或复用已有总线，缺省时新建一条独立
   * 总线，让不同 root runtime 的订阅互不干扰。
   */
  const bus = options.bus ?? createBus();
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
   * Profiler 的环境以 'Profiler' 为日志前缀单独创建，使其诊断日志与业务模块
   * 区分开；createProfiler 拿不到统计对象时会返回 null，因此调用方按可空处理。
   */
  const profiler =
    options.profiler === undefined
      ? createProfiler({
          env: createEnvMethods('Profiler'),
          getMemory: options.getProfilerMemory ?? (() => heapProfilerMemory),
          markMemoryDirty: options.markProfilerMemoryDirty,
          enable: options.enableProfiler ?? DEFAULT_PROFILER_ENABLE,
        })
      : options.profiler;

  const createContext = (
    moduleName: string,
    moduleOptions: ModuleContextOptions = {}
  ): ModuleContext => {
    /**
     * 每次派生模块上下文时重新创建 env。
     *
     * bus/profiler 共享 root 单例；env 则按 moduleName 独立创建，让日志
     * 能准确标识来源模块，也允许不同模块使用不同日志配置。
     *
     * 这里刻意不缓存派生结果：env 只包含无状态的 Game 访问方法和一个 logger，
     * 创建成本极低，缓存反而会让闭包长期持有已不再使用的日志配置。
     */
    return {
      bus,
      env: createEnvMethods(
        moduleName,
        moduleOptions.log,
        moduleOptions.notify
      ),
      profiler,
    };
  };

  return createContext;
};
