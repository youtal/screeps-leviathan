/**
 * 文件摘要：kernel.context，为模块与动态实例派生上下文，并维护每个模块的运行记录与实例表
 * （设计见 docs/design/kernel/README.md 第 3、4 节，契约见 src/contracts/context.ts）。
 *
 * 所属位置：src/kernel/context/，kernel 内部模块；只依赖 contracts 与 kernel 内的 logger、profiler、memory，
 * 由 kernel.lifecycle 调用，不向业务模块暴露本文件的实现类型。
 * 状态：每个模块一个 ModuleRuntime（运行状态、钩子、失败计数、实例表、清理函数），随 kernel 实例存在于一个 global。
 * 实例数量随站点增长，InstanceRecord 与 InstanceContextImpl 按架构 12.1 用无继承的扁平 class，日志与计时惰性创建，
 * 不为每个实例分配闭包。
 * 两类运行记录都实现 kernel.cpu 的 CpuNode：平滑耗用、连续落选次数、本 tick 判定结果与耗用直接存在记录上，
 * 字段在构造时按固定顺序初始化，保持隐藏类稳定（12.1）。上下文的 cpu 为 kernel.cpu 按层级提供的预算视图。
 */
import type { ConsoleRegistry } from '@/contracts/console';
import type { BootModeView } from '@/contracts/mode';
import type { InstanceContext, InstanceHooks, ModuleContext, PhaseHooks } from '@/contracts/context';
import type { CpuBudget, Tier } from '@/contracts/cpu';
import type { Logger, Measure } from '@/contracts/log';
import type { ModuleDefinition } from '@/contracts/module';
import type { ConsoleHost } from '@/kernel/console';
import { type CpuNode, VERDICT_NONE, type Verdict, maintenancePhase } from '@/kernel/cpu';
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
   * @description 身份用的 shard 名（架构 11.3 的 here），用于新建的项目标记：运行环境提供 InterShardMemory 时为
   * Game.shard.name，否则为 'x'。私服的 Game.shard 是服务器主机名（附录 A F7），不作为身份。
   * @returns shard 名；私服为 'x'。
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
  /** 控制台注册；模块上下文的 console 取其中以模块 id 为命名空间的注册器。 */
  readonly console: ConsoleHost;
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

/** 实例没有 requires 依赖；共享的空数组。 */
const NO_DEPS: readonly CpuNode[] = Object.freeze([]);

/** 一个动态实例的运行记录；同时是 kernel.cpu 的准入节点。 */
export class InstanceRecord implements Breakable, CpuNode {
  readonly key: string;
  /** 维护层的错峰相位，构造时由进程键算出。 */
  readonly phase: number;
  readonly hooks: InstanceHooks;
  /** 添加时的阶段序号；只在之后的阶段参与调度。 */
  readonly since: number;
  readonly tier: Tier;
  readonly owner: CpuNode;
  readonly deps: readonly CpuNode[];
  failures: number;
  broken: boolean;
  runnable: boolean;
  cost: number;
  sampled: boolean;
  starve: number;
  verdict: Verdict;
  spent: number;
  /**
   * 实例计时器：开启实例计时（ContextServices.profileInstances）时为实例上下文的 measure，否则为 undefined。
   * 由记录直接持有，执行钩子时不再按进程键查找上下文（审计 PA-04）。
   */
  measure: Measure | undefined;

  /**
   * @description 创建实例记录；层级继承所属模块，准入时要求所属模块未落选。
   * @param key 完整进程键。
   * @param hooks 实例钩子。
   * @param since 添加时的阶段序号。
   * @param owner 所属模块的运行记录。
   */
  constructor(key: string, hooks: InstanceHooks, since: number, owner: ModuleRuntime) {
    this.key = key;
    this.phase = maintenancePhase(key);
    this.hooks = hooks;
    this.since = since;
    this.tier = owner.tier;
    this.owner = owner;
    this.deps = NO_DEPS;
    this.failures = 0;
    this.broken = false;
    this.runnable = false;
    this.cost = 0;
    this.sampled = false;
    this.starve = 0;
    this.verdict = VERDICT_NONE;
    this.spent = 0;
    this.measure = undefined;
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

/** 一个模块的运行记录：上下文、钩子、状态、熔断、实例表与清理函数；同时是 kernel.cpu 的准入节点。 */
export class ModuleRuntime implements Breakable, CpuNode {
  readonly def: ModuleDefinition;
  readonly services: ContextServices;
  readonly ctx: ModuleContext;
  /** { [实例键（不含模块 ID）]: 实例记录 }，按添加顺序迭代。 */
  readonly instances: Map<string, InstanceRecord>;
  /** onDispose 登记的清理函数，按登记顺序调用。 */
  readonly disposers: (() => void)[];
  /** { [实例键]: 惰性派生的实例上下文 }。 */
  private readonly contexts: Map<string, InstanceContextImpl>;
  /** 进程键，即模块 id。 */
  readonly key: string;
  /** 维护层的错峰相位，构造时由进程键算出。 */
  readonly phase: number;
  readonly tier: Tier;
  readonly owner: undefined;
  /** requires 指向的模块运行记录；由 lifecycle 在全部运行记录创建后填入。 */
  readonly deps: CpuNode[];
  hooks: PhaseHooks | undefined;
  state: ModuleState;
  failures: number;
  broken: boolean;
  /** 本 tick 是否处于运维暂停（覆盖或清单默认值）；每 tick 准入前由 lifecycle 计算，生存层恒为 false。 */
  paused: boolean;
  /** 本 tick 阶段开始前计算：已就绪、未熔断、未暂停，且 requires 的模块都可运行。 */
  runnable: boolean;
  cost: number;
  sampled: boolean;
  starve: number;
  verdict: Verdict;
  spent: number;
  /** 惰性创建的控制台注册器（只暴露 command 与 setting）。 */
  private registry: ConsoleRegistry | undefined;

  /**
   * @description 创建模块运行记录并派生模块上下文；不调用 setup。
   * @param def 模块定义。
   * @param services kernel 服务。
   * @param budgets 每个层级的 CPU 预算视图（kernel.cpu）。
   * @param phase 读取当前阶段序号的函数，用于标记新增实例。
   */
  constructor(def: ModuleDefinition, services: ContextServices, budgets: Readonly<Record<Tier, CpuBudget>>, phase: () => number) {
    this.def = def;
    this.services = services;
    this.instances = new Map();
    this.disposers = [];
    this.contexts = new Map();
    this.key = def.id;
    this.phase = maintenancePhase(def.id);
    this.tier = def.tier;
    this.owner = undefined;
    this.deps = [];
    this.hooks = undefined;
    this.state = 'ready';
    this.failures = 0;
    this.broken = false;
    this.paused = false;
    this.runnable = false;
    this.cost = 0;
    this.sampled = false;
    this.starve = 0;
    this.verdict = VERDICT_NONE;
    this.spent = 0;
    this.registry = undefined;
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
            const context = runtime.instance(key);
            const record = new InstanceRecord(full, create(context), phase(), runtime);
            // 计时器在添加时取得一次，惰性创建的计时只在开启实例计时时发生。
            if (services.profileInstances) record.measure = context.measure;
            runtime.instances.set(key, record);
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
       * @description 控制台注册器，命名空间为模块 id；首次取用时创建，只暴露 command 与 setting。
       * @returns 注册器。
       */
      get console() { return runtime.consoleRegistry(); },
      /**
       * @description 登记软重置时的清理函数。
       * @param fn 清理函数。
       * @returns 无返回值。
       */
      onDispose(fn) { runtime.disposers.push(fn); },
    };
  }

  /**
   * @description 取得本模块的控制台注册器；宿主侧的 offline 不对模块开放。
   * @returns 注册器。
   */
  consoleRegistry(): ConsoleRegistry {
    if (!this.registry) {
      const host = this.services.console.registry(this.def.id);
      this.registry = Object.freeze({ command: host.command, setting: host.setting });
    }
    return this.registry;
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
