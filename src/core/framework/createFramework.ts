/**
 * 文件摘要：Framework 组合 CPU 准入、错误映射、插件注册和意图仲裁，提供同步 loop 和管理接口。
 * 生命周期变更在 tick 边界事务性生效；服务、上下文、健康状态及 Profiler 统计仅存在于实例 heap。
 * Memory 由注入的 MemoryManager 在 tick 边界驱动（begin/end），框架自身不挂载 Memory、
 * 不读写 RawMemory，也不解释持久化数据；global reset 后按 journal 与目录恢复。
 * Game 对象不得跨 tick 保存；本 tick 失败集合和意图每轮重建，注册/计时缓存随实例存活。
 */
import { createBus } from '../eventBus';
import type { Bus, EventScope, EventType, DataByEvent } from '@/contracts';
import { createLogging } from '@/core/logger';
import { createProfiler } from '../profiler';
import { createEnvMethods } from '../runtime/env';
import { createCpuGovernor } from './cpuGovernor';
import { createErrorMapper } from './errorMapper';
import { createIntentBroker } from './intentBroker';
import { validId } from './pluginRegistry';
import type { ApplyMemoryAccessor } from '@/contracts/memory';
import type { Framework } from '@/contracts/plugin';
import type { ProfilerMemory } from '../profiler/types';
import { createPluginRegistry, PluginEntry } from './pluginRegistry';
import type {
  FrameworkOptions,
  LeviathanPlugin,
  Phase,
  PluginContext,
  PluginFailure,
} from '@/contracts';
import type { PluginHealth } from './types';

/** 创建独立的 heap 实例；首次 loop 激活插件和统计器，所有状态在 global reset 后丢失。 */
export const createFramework = (options: FrameworkOptions = {}): Framework => {
  const getGame = options.getGame ?? (() => Game);
  /** 健康表和统计容器随实例创建，跨 tick 复用；不恢复磁盘数据。 */
  const healthTable = new Map<string, PluginHealth>();
  const profilerMemory: ProfilerMemory = {};
  const cpu = createCpuGovernor(getGame, options.reserveCpu, options.minBucket);
  /**
   * 日志工厂在装配阶段创建一次：注入的工厂与 Runtime 共用一套等级、输出端口和
   * 邮件策略；缺省使用 core/logger 兜底工厂，保持 createFramework 可独立创建。
   * 错误映射、事件总线、Profiler 与各插件 env 都从它派生作用域日志器。
   */
  const logging = options.logging ?? createLogging();
  /**
   * 未装配 MemoryManager 时的申请入口：直接抛配置错误，而不是返回永久 pending 的
   * 句柄——插件依赖持久状态时必须显式装配存储，不能把配置问题伪装成等待。
   */
  const unboundMemory: ApplyMemoryAccessor = () => {
    throw new Error('MemoryManager is not assembled');
  };
  const errors = createErrorMapper(
    options.loadSourceMap,
    options.report,
    logging
  );
  const registry = createPluginRegistry();
  const bus = createBus(logging);
  /** 连续失败达到该值即熔断；熔断插件不参与后续 tick，必须显式 recover 才重新准入。 */
  const threshold = options.failureThreshold ?? 3;
  if (!Number.isInteger(threshold) || threshold < 1)
    throw new Error('Invalid failure threshold');

  // 命令只改候选集合；依赖验证失败时保留整个旧集合，避免半安装状态。
  type Mutation = (entries: Map<string, PluginEntry>) => void;
  let pending: Mutation[] = [];
  /** global 级独占服务表；停用/卸载/失败 setup 清理 owner 所属条目，不写入 Memory。 */
  const services = new Map<string, { owner: string; value: unknown }>();
  /** 已激活实例；复用 Context 和业务缓存，只有重新激活才重做 setup。 */
  const initialized = new Map<
    string,
    { plugin: LeviathanPlugin; cleanup: (() => void)[]; context: PluginContext }
  >();
  /** setup 尚未登记 initialized 时暂存清理函数，以便部分初始化失败也能逆序释放。 */
  let activeCleanup: (() => void)[] | undefined;
  let profiler = options.profiler;
  let profileReady = false;
  /** 每个固定标签只 wrap 一次；Profiler 延迟就绪时清空，之后随实例存活。 */
  const wrappers = new Map<string, (callback: () => any) => any>();
  /**
   * 包装器构造失败时降级，不能因观测初始化失败而跳过业务钩子。
   * 命中缓存的包装器后，单次调用的额外开销只剩一次 Map 查询与一次函数调用。
   */
  const measure = <T>(label: string, callback: () => T): T => {
    let wrapper = wrappers.get(label);
    if (!wrapper) {
      try {
        wrapper = profiler
          ? profiler.wrap(label, (fn: () => any) => fn())
          : (fn) => fn();
      } catch {
        wrapper = (fn) => fn();
      }
      wrappers.set(label, wrapper);
    }
    return wrapper(callback);
  };
  // 错误映射与 report 回调同样走 Profiler 计时，避免故障路径的耗时在统计中隐形。
  errors.setMeasure(measure);
  /** 动态调用归属，用于限制 setup/submit 权限；嵌套事件回调退出后必须恢复外层值。 */
  let currentPhase: Phase = 'framework';
  let currentPlugin = '';
  /** running 防止递归 loop；lastTick 防止同 tick 重复执行，失败 tick 也不重放。 */
  let running = false;
  let lastTick: number | undefined;
  /** 以下诊断、可用集合与 broker 每 tick 重建；-1 broker 仅为首次 loop 前占位。 */
  let failures: PluginFailure[] = [];
  let safeMode = false;
  let broker = createIntentBroker(-1);
  /** 意图回执只服务紧邻下一 tick 的事实核验，保留在 heap，global reset 后由世界状态重建。 */
  let previousReceipts: import('./types').IntentReceipt[] = [];
  let failed = new Set<string>();
  let available = new Set<string>();

  /**
   * 先检查局部身份，再排队完整图验证；调用返回不表示已安装成功。
   * frozen 是私有描述副本而非 Object.freeze；函数引用固定，其捕获的业务闭包仍可变。
   */
  const register = (plugin: LeviathanPlugin) => {
    const m = { ...plugin.manifest };
    if (
      !validId(m.id) ||
      m.id === 'framework' ||
      !Number.isInteger(m.version) ||
      m.version < 1
    )
      throw new Error('Invalid plugin manifest');
    // 固定描述和函数引用，注册后调用者修改原对象不会改变当前 tick 语义。
    const frozen = {
      ...plugin,
      manifest: {
        ...m,
        requires: [...(m.requires ?? [])],
        optional: [...(m.optional ?? [])],
        provides: [...(m.provides ?? [])],
      },
    };
    pending.push((entries) => {
      if (entries.has(m.id)) throw new Error('Duplicate plugin: ' + m.id);
      entries.set(m.id, { plugin: frozen, enabled: true });
    });
  };
  /** 排队启停，保留本实例的健康记录；未知 ID 的错误在下 tick 应用命令时报告。 */
  const enable = (id: string, enabled = true): void => {
    pending.push((entries) => {
      const entry = entries.get(id);
      if (!entry) throw new Error('Unknown plugin: ' + id);
      entry.enabled = enabled;
    });
  };
  /** 删除注册记录；不触碰任何外部存储；仍被必需依赖引用时整个候选批次验证失败。 */
  const unregister = (id: string): void => {
    pending.push((entries) => {
      entries.delete(id);
    });
  };
  (options.plugins ?? []).forEach(register);

  /**
   * ErrorBoundary 在 Profiler 外，插件抛错时先结束计时，再单独统计映射/报告。
   * 事件总线同步调用可嵌套进入其他插件，必须保存/恢复归属，避免外层后续操作权限错位。
   * failed 按 ID 去重供健康统计使用，failures 则保留每次故障供诊断。
   */
  const invoke = <T>(id: string, phase: Phase, callback: () => T) => {
    const previousPlugin = currentPlugin;
    const previousPhase = currentPhase;
    currentPlugin = id;
    currentPhase = phase;
    const label =
      id === 'framework' ? 'framework.' + phase : 'plugin.' + id + '.' + phase;
    const result = errors.capture(
      { tick: getGame().time, pluginId: id, phase },
      () => measure(label, callback)
    );
    if (result.ok === false) {
      failures.push(result.failure);
      failed.add(id);
    }
    currentPlugin = previousPlugin;
    currentPhase = previousPhase;
    return result;
  };
  /**
   * 按获取资源的逆序释放；单个 cleanup 抛错仍继续其他项，再移除服务与实例。
   * 只释放运行时资源，不读写外部存储；不直接调用业务方法撤销游戏动作。
   */
  const dispose = (id: string) => {
    const instance = initialized.get(id);
    if (!instance) return;
    for (const cleanup of instance.cleanup.slice().reverse())
      invoke(id, 'dispose', cleanup);
    initialized.delete(id);
    for (const [name, service] of services)
      if (service.owner === id) services.delete(name);
  };
  /** 懒创建 heap 健康记录；禁用后仍保留熔断，显式 recover 或新实例才能解除。 */
  const health = (id: string): PluginHealth => {
    let record = healthTable.get(id);
    if (!record) {
      record = { failures: 0, consecutiveFailures: 0, circuitOpen: false };
      healthTable.set(id, record);
    }
    return record;
  };
  /**
   * 为一次插件激活创建能力对象，兼容原有 ModuleContext 业务工厂。
   * Game 查询方法在调用时读取当前 Game；getObjectById 的断言保留宿主泛型重载签名。
   * 自定义 createContext 可替换基础环境/总线，但仍会被生命周期权限代理包裹。
   */
  const context = (plugin: LeviathanPlugin): PluginContext => {
    const id = plugin.manifest.id;
    const base = options.createContext
      ? options.createContext(id)
      : {
          bus,
          profiler: profiler ?? null,
          env: {
            ...createEnvMethods(id, {}, undefined, logging),
            getGame,
            getRoom: (name: string) => getGame().rooms[name],
            getCreep: (name: string) => getGame().creeps[name],
            getPowerCreep: (name: string) => getGame().powerCreeps[name],
            getFlag: (name: string) => getGame().flags[name],
            getObjectById: ((objectId: Id<_HasId>) =>
              getGame().getObjectById(objectId)) as typeof Game.getObjectById,
          },
        };
    // 框架代理订阅自动归属插件；停用后释放。迟到的事件不得唤醒不可用插件。
    const scopedBus: Bus = {
      ...base.bus,
      unsubscribe: (scope, type, subscriber) =>
        base.bus.unsubscribe(scope, type, id + ':' + subscriber),
      // T 将事件类型绑定到 DataByEvent<T> 载荷；订阅者键加插件前缀避免常规名称相互覆盖。
      subscribe: <T extends EventType>(
        scope: EventScope,
        type: T,
        subscriber: string,
        listener: (data: DataByEvent<T>) => void
      ) => {
        const owner = initialized.get(id)?.cleanup ?? activeCleanup;
        if (!owner || currentPlugin !== id || currentPhase !== 'setup')
          throw new Error('Subscribe only during setup');
        const key = id + ':' + subscriber;
        base.bus.subscribe(scope, type, key, (data) => {
          if (available.has(id) && !failed.has(id))
            invoke(id, currentPhase, () => listener(data));
        });
        // 保存对同一底层总线/作用域/类型/键的释放闭包，setup 回滚与停用共用清理路径。
        owner.push(() => base.bus.unsubscribe(scope, type, key));
      },
    };
    // Omit 暂时去除后续以访问器补齐的字段；避免对象展开时把动态值提前求出。
    const result: Omit<PluginContext, 'tick'> = {
      ...base,
      bus: scopedBus,
      events: scopedBus,
      pluginId: id,
      cpu,
      memory: options.memory ? options.memory.bind(id) : unboundMemory,
      services: {
        // unknown 服务载荷只在出口断言为 T；这不是运行时结构校验，使用者负责服务协议。
        get: <T>(name: string): T => {
          const service = services.get(name);
          if (
            !service ||
            !available.has(service.owner) ||
            failed.has(service.owner)
          )
            throw new Error('Unavailable service: ' + name);
          if (
            service.owner !== id &&
            ![
              ...(plugin.manifest.requires ?? []),
              ...(plugin.manifest.optional ?? []),
            ].includes(service.owner)
          )
            throw new Error('Undeclared service dependency: ' + name);
          return service.value as T;
        },
        // 只允许 setup 安装服务，不允许运行到一半替换其他插件已经取得的实例。
        provide: (name, value) => {
          if (
            currentPlugin !== id ||
            currentPhase !== 'setup' ||
            !plugin.manifest.provides?.includes(name)
          ) {
            throw new Error('Undeclared service or invalid phase: ' + name);
          }
          if (services.has(name))
            throw new Error('Service already provided: ' + name);
          services.set(name, { owner: id, value });
        },
      },
      intents: {
        submit: (intent) => {
          if (
            currentPlugin !== id ||
            currentPhase !== 'tickExecute' ||
            !available.has(id)
          ) {
            throw new Error('Submit intents only in onTickExecute');
          }
          return broker.submit(id, intent);
        },
        receipts: () => broker.receipts().filter((r) => r.pluginId === id),
        // 回执只保留在 heap；返回副本，避免使用者修改下一 tick 的核验输入。
        previous: () =>
          previousReceipts
            .filter((r) => r.pluginId === id)
            .map((r) => ({ ...r })),
      },
      onDispose: (cleanup) => {
        if (currentPlugin !== id || currentPhase !== 'setup' || !activeCleanup)
          throw new Error('onDispose only during setup');
        activeCleanup.push(cleanup);
      },
    };
    // ES2017 的对象展开会被编译为 Object.assign；显式定义访问器，避免 tick
    // 在复制时求值并退化为固定字段。
    Object.defineProperties(result, {
      tick: { enumerable: true, get: () => getGame().time },
    });
    return result as PluginContext;
  };
  /** 拓扑遍历阶段检查直接依赖即可逐层挂起；提交阶段另递归检查传递依赖的新故障。 */
  const dependenciesReady = (plugin: LeviathanPlugin) =>
    (plugin.manifest.requires ?? []).every(
      (id) => available.has(id) && !failed.has(id)
    );

  /**
   * 同步主循环：边界变更 → 激活 → begin → execute/仲裁/commit → end/heap 健康统计。
   * finally 处理可捕获异常的收尾，但无法保证引擎硬 CPU 终止后继续运行；插件仍须分批工作。
   * 普通插件故障隔离到自身/依赖者，关键插件故障进入本 tick safeMode 并停止后续提交。
   */
  const loop = (): void => {
    if (running) throw new Error('Framework loop is not reentrant');
    if (lastTick === getGame().time) return;
    running = true;
    lastTick = getGame().time;
    failures = [];
    failed = new Set();
    available = new Set();
    safeMode = false;
    broker = createIntentBroker(getGame().time);
    /** participants 已激活且获准参与；entered 确实进入 begin，决定谁必须得到 end。 */
    const participants: { plugin: LeviathanPlugin; ctx: PluginContext }[] = [];
    const entered: typeof participants = [];
    /** 注册批次验证成功后才统计参与集合，失败批次不改变已有健康记录。 */
    let registryReady = false;
    /**
     * 本轮是否有插件因 CPU 准入被跳过。被跳过的插件不会执行 setup，也就不会提出
     * Memory 申请；此时必须延后封存启动窗口，否则它会在窗口关闭后才申请而失去
     * Segment 资格（设计文档 §4：申请不能依赖 CPU 准入）。
     */
    let startupPending = false;
    try {
      // Memory 生命周期先于插件阶段开始：解析/恢复与页激活在 setup 申请之前完成。
      // 用错误边界包裹：存储异常按内核故障记录并进入安全模式，绝不把异常留在
      // tick 之外（否则 running 无法复位，之后每个 tick 都会被判定为不可重入）。
      const memoryBegin = invoke('framework', 'framework', () =>
        options.memory?.begin(getGame().time)
      );
      if (!memoryBegin.ok) safeMode = true;
      // 先摘下本批队列；执行期间新排队的命令留给下一 tick，失败批次丢弃而不自动重试。
      const commands = pending;
      pending = [];
      if (commands.length) {
        const candidate = registry.copy();
        const update = invoke('framework', 'framework', () => {
          commands.forEach((command) => command(candidate));
          registry.replace(candidate);
        });
        if (!update.ok) {
          safeMode = true;
          return;
        }
      }
      const ordered = registry.ordered();
      const byId = new Map(
        ordered.map((e) => [e.plugin.manifest.id, e.plugin])
      );
      registryReady = true;
      // 延迟到 loop 创建 Profiler，避免模块导入或构造期访问 Game。
      if (!profileReady) {
        try {
          profiler =
            options.profiler !== undefined
              ? options.profiler
              : createProfiler({
                  env: {
                    ...createEnvMethods('Profiler', {}, undefined, logging),
                    getGame,
                  },
                  getMemory: () => profilerMemory,
                  enable: options.enableProfiler ?? false,
                });
        } catch {
          // 性能组件是可选观测设施；初始化失败也必须保留异常隔离与主循环。
          profiler = null;
        }
        profileReady = true;
        wrappers.clear();
      }
      const enabled = new Set(
        ordered
          .filter((e) => e.enabled && !health(e.plugin.manifest.id).circuitOpen)
          .map((e) => e.plugin.manifest.id)
      );
      // 依赖停用后级联挂起使用者；逆序清理使服务在使用者释放时仍存在。
      for (const { plugin } of ordered) {
        if ((plugin.manifest.requires ?? []).some((id) => !enabled.has(id)))
          enabled.delete(plugin.manifest.id);
        if (plugin.manifest.critical && health(plugin.manifest.id).circuitOpen)
          safeMode = true;
      }
      for (const id of [...initialized.keys()].reverse()) {
        if (!enabled.has(id) || byId.get(id) !== initialized.get(id)?.plugin)
          dispose(id);
      }
      for (const { plugin } of ordered) {
        if (safeMode) break;
        const id = plugin.manifest.id;
        if (!enabled.has(id) || !dependenciesReady(plugin)) continue;
        if (!cpu.admit(plugin.manifest.critical)) {
          startupPending = true;
          continue;
        }
        // Context 是 global 级闭包；tick 和 broker 均在使用时读取当前值。
        const ctx = initialized.get(id)?.context ?? context(plugin);
        if (!initialized.has(id)) {
          activeCleanup = [];
          const setup = invoke(id, 'setup', () => {
            const value: unknown = plugin.setup?.(ctx);
            if (value && typeof (value as any).then === 'function')
              return value;
            for (const name of plugin.manifest.provides ?? []) {
              if (services.get(name)?.owner !== id)
                throw new Error('Missing provided service: ' + name);
            }
          });
          // 即使 setup 失败也暂登记清理列表，使 dispose 能释放已发布服务和部分订阅。
          initialized.set(id, { plugin, cleanup: activeCleanup, context: ctx });
          activeCleanup = undefined;
          if (!setup.ok) {
            dispose(id);
            // setup 失败的插件可能还没来得及申请 Memory：窗口不能就此封存，
            // 否则它恢复后只能落到主 Memory 后端。
            startupPending = true;
            if (plugin.manifest.critical) {
              safeMode = true;
              break;
            }
            continue;
          }
        }
        available.add(id);
        participants.push({ plugin, ctx });
      }
      // 先完成全部 setup，使低依赖发布者 begin 时高层订阅者已经注册。
      measure('framework.tickBegin', () => {
        for (const { plugin, ctx } of participants) {
          if (safeMode) break;
          const id = plugin.manifest.id;
          if (
            !dependenciesReady(plugin) ||
            !cpu.admit(plugin.manifest.critical)
          ) {
            available.delete(id);
            continue;
          }
          // 在调用前登记，begin 抛错也能进入 finally 的 end；不是执行成功后才登记。
          entered.push({ plugin, ctx });
          const begin = invoke(id, 'tickBegin', () =>
            plugin.onTickBegin?.(ctx)
          );
          if (!begin.ok && plugin.manifest.critical) {
            safeMode = true;
            break;
          }
        }
      });
      if (!safeMode) {
        measure('framework.tickExecute.plan', () => {
          for (const { plugin, ctx } of entered) {
            const id = plugin.manifest.id;
            if (
              failed.has(id) ||
              !dependenciesReady(plugin) ||
              !cpu.admit(plugin.manifest.critical)
            ) {
              available.delete(id);
              continue;
            }
            const result = invoke(id, 'tickExecute', () =>
              plugin.onTickExecute?.(ctx)
            );
            if (!result.ok && plugin.manifest.critical) {
              safeMode = true;
              break;
            }
          }
        });
      }
      if (!safeMode)
        // 四个注入回调依次提供内核策略：依赖可用性判定、CPU 剩余预算、带错误边界的执行入口、
        // 以及计时包装。仲裁顺序与锁语义由 broker 负责，Kernel 只决定"谁有资格参与本次提交"。
        broker.commit(
          (id) => {
            // 提交途中依赖可能新失败，递归检查整个必需依赖链；图已无环，无需环保护。
            // 此处不缓存结果，以免在同批提交中复用失败前的可用状态。
            const ready = (key: string): boolean =>
              available.has(key) &&
              !failed.has(key) &&
              (byId.get(key)?.manifest.requires ?? []).every(ready);
            return ready(id);
          },
          () => cpu.remaining() > 0,
          (id, callback) => {
            const result = invoke(id, 'commit', callback);
            if (!result.ok && byId.get(id)?.manifest.critical) {
              safeMode = true;
              available.clear();
            }
            return result;
          },
          measure
        );
    } catch (error) {
      safeMode = true;
      invoke('framework', 'framework', () => {
        throw error;
      });
    } finally {
      // 收尾阶段整体再包一层 try/finally：即使 end 钩子或 Memory 收尾抛错，
      // 也一定复位 running 与归属状态，避免后续 tick 全部被判为不可重入。
      try {
        // 所有已经进入 begin 的插件都得到 end，包括自身 begin 失败者，以便释放本 tick 状态。
        measure('framework.tickEnd', () => {
          for (const { plugin, ctx } of entered.slice().reverse()) {
            invoke(plugin.manifest.id, 'tickEnd', () =>
              plugin.onTickEnd?.(ctx)
            );
          }
        });
        if (registryReady) {
          const result = invoke('framework', 'tickEnd', () => {
            for (const { plugin } of registry.ordered()) {
              const id = plugin.manifest.id;
              const h = health(id);
              // 多钩子/多意图故障按本 tick 一次累计；跳过的插件不会重置连续失败数。
              if (failed.has(id)) {
                if (plugin.manifest.critical) safeMode = true;
                h.failures++;
                h.consecutiveFailures++;
                h.circuitOpen = h.consecutiveFailures >= threshold;
              } else if (
                entered.some((p) => p.plugin === plugin) &&
                available.has(id) &&
                h.consecutiveFailures > 0
              ) {
                h.consecutiveFailures = 0;
              }
            }
            previousReceipts = broker.receipts();
          });
          if (!result.ok) safeMode = true;
        }
        // 提前中止（安全模式）、插件因 CPU 未准入或 setup 失败时都不封存启动申请
        // 窗口，留给后续 tick 继续收集；依赖未就绪导致的跳过不作为申请缺失处理。
        if (safeMode || startupPending) options.memory?.deferStartupWindow();
        // Memory 收尾在插件 end 与健康累计之后：封存窗口、推进迁移、提交 dirty 分区。
        const memoryEnd = invoke('framework', 'tickEnd', () =>
          options.memory?.end(getGame().time)
        );
        if (!memoryEnd.ok) safeMode = true;
      } finally {
        running = false;
        // 无论本轮是否 safeMode，都恢复内核归属状态，避免污染下一次 loop 的权限判定。
        currentPhase = 'framework';
        currentPlugin = '';
        activeCleanup = undefined;
      }
    }
  };
  return {
    loop,
    register,
    enable,
    disable: (id: string) => enable(id, false),
    unregister,
    /** 恢复必须位于 tick 外；只清 heap 熔断及连续失败，历史计数保留。 */
    recover: (id: string) => {
      if (running) throw new Error('Recover outside loop');
      if (!registry.copy().has(id)) throw new Error('Unknown plugin: ' + id);
      const h = health(id);
      h.circuitOpen = false;
      h.consecutiveFailures = 0;
    },
    // 对外返回当前诊断快照，复制故障对象，避免调用方篡改内核下次读取的状态。
    getStatus: () => ({
      safeMode,
      tick: lastTick,
      failures: failures.map((f) => ({ ...f })),
    }),
  };
};
