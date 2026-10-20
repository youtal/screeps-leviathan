/**
 * 文件摘要：kernel.context，为模块与动态实例派生上下文，并维护每个模块的运行记录与实例表
 * （设计见 docs/design/kernel/README.md 第 3、4 节，契约见 src/contracts/context.ts）。
 *
 * 所属位置：src/kernel/context/，kernel 内部模块；只依赖 contracts 与 kernel 内的 logger、profiler、memory，
 * 由 kernel.lifecycle 调用，不向业务模块暴露本文件的实现类型。
 * 状态：每个模块一个 ModuleRuntime（运行状态、钩子、失败计数、实例表、清理函数），随 kernel 实例存在于一个 global。
 * 实例数量随站点增长，InstanceRecord 与 InstanceContextImpl 按架构 12.1 用无继承的扁平 class，日志与计时惰性创建，
 * 不为每个实例分配闭包。
 * cpu 模块交付前的临时预算：每个层级共享一个 CpuBudget，剩余 = tickLimit − 已用 − 收尾预留，收尾预留 = max(2, 10% × limit)。
 */
import type { BootModeView } from '@/contracts/mode';
import type { InstanceContext, InstanceHooks, ModuleContext, PhaseHooks } from '@/contracts/context';
import type { CpuBudget, Tier } from '@/contracts/cpu';
import type { Logger, Measure } from '@/contracts/log';
import type { ModuleDefinition } from '@/contracts/module';
import type { LogRoot } from '@/kernel/logger';
import type { createMemory } from '@/kernel/memory';
import type { Profiler } from '@/kernel/profiler';

/** 当 tick 的游戏事实，由装配方从 Game 读取；测试中替换。 */
export interface GamePort {
  /**
   * @description 当前 tick。
   * @returns Game.time。
   */
  time(): number;
  /**
   * @description 本 tick 已用 CPU。
   * @returns Game.cpu.getUsed()。
   */
  cpuUsed(): number;
  /**
   * @description 本 tick 可用的 CPU 上限。
   * @returns Game.cpu.tickLimit。
   */
  tickLimit(): number;
  /**
   * @description 每 tick 的 CPU 额度。
   * @returns Game.cpu.limit。
   */
  limit(): number;
  /**
   * @description 当前 bucket。
   * @returns Game.cpu.bucket。
   */
  bucket(): number;
  /**
   * @description 当前 shard 名，用于新建的项目标记；私服没有 Game.shard（附录 A F7）。
   * @returns Game.shard.name；私服为 'x'。
   */
  shard(): string;
  /**
   * @description 本 tick 存在的 creep 名称，含孵化中的 creep。
   * @returns 名称集合。
   */
  creepNames(): ReadonlySet<string>;
  /**
   * @description 本 tick 存在的 flag 名称。
   * @returns 名称集合。
   */
  flagNames(): ReadonlySet<string>;
}

/** kernel.memory 宿主实例。 */
export type MemoryHost = ReturnType<typeof createMemory>;

/** 派生上下文所需的 kernel 服务。 */
export interface ContextServices {
  readonly logRoot: LogRoot;
  readonly profiler: Profiler;
  readonly game: GamePort;
  readonly memory: MemoryHost;
  /** 是否对实例钩子单独计时；默认只按模块计时。 */
  readonly profileInstances: boolean;
  /**
   * @description 读取当前的启动判定结果。
   * @returns 只读模式视图。
   */
  mode(): BootModeView;
}

/** 模块的运行状态：已就绪、初始化失败（含清单校验被拒绝）。 */
export type ModuleState = 'ready' | 'failed';

/** 可熔断的进程：连续失败计数与是否已熔断。 */
export interface Breakable {
  failures: number;
  broken: boolean;
}

/**
 * @description 创建每个层级共享的临时 CPU 预算（cpu 模块交付前使用）。
 * @param game 游戏事实端口。
 * @returns { [层级]: 预算视图 }。
 */
export const createCpuBudgets = (game: GamePort): Readonly<Record<Tier, CpuBudget>> => {
  /**
   * @description 计算本 tick 剩余可用 CPU：tickLimit − 已用 − 收尾预留。
   * @returns 剩余 CPU，可能为负。
   */
  const remaining = (): number => game.tickLimit() - game.cpuUsed() - Math.max(2, game.limit() * 0.1);
  /**
   * @description 创建一个层级的预算视图。
   * @param tier 层级。
   * @returns 预算视图。
   */
  const budget = (tier: Tier): CpuBudget => ({
    tier, remaining,
    /**
     * @description 剩余不足收尾预留时让出。
     * @returns 剩余 CPU 不大于 0 时为 true。
     */
    shouldYield: () => remaining() <= 0,
  });
  return { survival: budget('survival'), economy: budget('economy'), maintenance: budget('maintenance'), planning: budget('planning') };
};

/** 一个动态实例的运行记录。 */
export class InstanceRecord implements Breakable {
  readonly key: string;
  readonly hooks: InstanceHooks;
  /** 添加时的阶段序号；只在之后的阶段参与调度。 */
  readonly since: number;
  failures: number;
  broken: boolean;

  /**
   * @description 创建实例记录。
   * @param key 完整进程键。
   * @param hooks 实例钩子。
   * @param since 添加时的阶段序号。
   */
  constructor(key: string, hooks: InstanceHooks, since: number) {
    this.key = key;
    this.hooks = hooks;
    this.since = since;
    this.failures = 0;
    this.broken = false;
  }
}

/** 实例上下文：日志与计时在首次取用时创建。 */
class InstanceContextImpl implements InstanceContext {
  readonly key: string;
  readonly cpu: CpuBudget;
  private readonly owner: ModuleRuntime;
  private logger: Logger | undefined;
  private timer: Measure | undefined;

  /**
   * @description 创建实例上下文。
   * @param owner 所属模块的运行记录。
   * @param key 完整进程键。
   */
  constructor(owner: ModuleRuntime, key: string) {
    this.key = key;
    this.cpu = owner.ctx.cpu;
    this.owner = owner;
    this.logger = undefined;
    this.timer = undefined;
  }

  /**
   * @description 作用域为进程键的日志，以所属模块的日志为父作用域。
   * @returns Logger。
   */
  get log(): Logger {
    this.logger ??= this.owner.services.logRoot.scope(this.key, this.owner.ctx.log);
    return this.logger;
  }

  /**
   * @description 按进程键聚合的计时。
   * @returns Measure。
   */
  get measure(): Measure {
    this.timer ??= this.owner.services.profiler.scope(this.key);
    return this.timer;
  }
}

/** 一个模块的运行记录：上下文、钩子、状态、熔断、实例表与清理函数。 */
export class ModuleRuntime implements Breakable {
  readonly def: ModuleDefinition;
  readonly services: ContextServices;
  readonly ctx: ModuleContext;
  /** { [实例键（不含模块 ID）]: 实例记录 }，按添加顺序迭代。 */
  readonly instances: Map<string, InstanceRecord>;
  /** onDispose 登记的清理函数，按登记顺序调用。 */
  readonly disposers: (() => void)[];
  /** { [实例键]: 惰性派生的实例上下文 }。 */
  private readonly contexts: Map<string, InstanceContextImpl>;
  hooks: PhaseHooks | undefined;
  state: ModuleState;
  failures: number;
  broken: boolean;
  /** 本 tick 阶段开始前计算：已就绪、未熔断，且 requires 的模块都可运行。 */
  runnable: boolean;

  /**
   * @description 创建模块运行记录并派生模块上下文；不调用 setup。
   * @param def 模块定义。
   * @param services kernel 服务。
   * @param budgets 每个层级的 CPU 预算。
   * @param phase 读取当前阶段序号的函数，用于标记新增实例。
   */
  constructor(def: ModuleDefinition, services: ContextServices, budgets: Readonly<Record<Tier, CpuBudget>>, phase: () => number) {
    this.def = def;
    this.services = services;
    this.instances = new Map();
    this.disposers = [];
    this.contexts = new Map();
    this.hooks = undefined;
    this.state = 'ready';
    this.failures = 0;
    this.broken = false;
    this.runnable = false;
    const runtime = this;
    const { id } = def;
    const log = services.logRoot.scope(id);
    this.ctx = {
      id, log, measure: services.profiler.scope(id), cpu: budgets[def.tier],
      /**
       * @description 本模块的分区工厂；Memory 就绪后才会创建上下文，取用时数据已就绪。
       * @returns 分区工厂。
       */
      get memory() { return services.memory.partitions(id); },
      /**
       * @description 本模块的房间实体空间。
       * @returns 实体空间。
       */
      get rooms() { return services.memory.entities(id).rooms; },
      /**
       * @description 本模块的 creep 实体空间。
       * @returns 实体空间。
       */
      get creeps() { return services.memory.entities(id).creeps; },
      /**
       * @description 本模块的 flag 实体空间。
       * @returns 实体空间。
       */
      get flags() { return services.memory.entities(id).flags; },
      /**
       * @description 当前的启动判定结果。
       * @returns 只读模式视图。
       */
      get mode() { return services.mode(); },
      processes: {
        /**
         * @description 添加动态实例；键已存在时忽略，create 抛错时记录并不添加。
         * @param key 实例键。
         * @param create 创建实例钩子的工厂。
         * @returns 无返回值。
         */
        add(key, create) {
          if (runtime.instances.has(key)) return;
          const full = `${id}:${key}`;
          try {
            runtime.instances.set(key, new InstanceRecord(full, create(runtime.instance(key)), phase()));
          } catch (error) {
            log.error(`实例 ${full} 创建失败`, error);
          }
        },
        /**
         * @description 移除实例并调用其 dispose；dispose 抛错只记录。
         * @param key 实例键。
         * @returns 无返回值。
         */
        remove(key) {
          const record = runtime.instances.get(key);
          if (!record) return;
          runtime.instances.delete(key);
          runtime.contexts.delete(key);
          try { record.hooks.dispose?.(); } catch (error) { log.error(`实例 ${record.key} 清理失败`, error); }
        },
        /**
         * @description 查询实例是否存在。
         * @param key 实例键。
         * @returns 存在时为 true。
         */
        has(key) { return runtime.instances.has(key); },
      },
      /**
       * @description 惰性派生并缓存实例上下文。
       * @param key 实例键。
       * @returns 实例上下文。
       */
      instance(key) { return runtime.instance(key); },
      /**
       * @description 登记软重置时的清理函数。
       * @param fn 清理函数。
       * @returns 无返回值。
       */
      onDispose(fn) { runtime.disposers.push(fn); },
    };
  }

  /**
   * @description 惰性派生并缓存实例上下文。
   * @param key 实例键（不含模块 ID）。
   * @returns 实例上下文。
   */
  instance(key: string): InstanceContext {
    let context = this.contexts.get(key);
    if (!context) {
      context = new InstanceContextImpl(this, `${this.def.id}:${key}`);
      this.contexts.set(key, context);
    }
    return context;
  }
}
