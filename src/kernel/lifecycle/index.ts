/**
 * 文件摘要：kernel.lifecycle，kernel 的宿主接口与 tick 流水线（设计见 docs/design/kernel/README.md 第 1–3 节）。
 *
 * 所属位置：src/kernel/lifecycle/，kernel 的唯一对外入口，只由 app.assembly 与 main.ts 使用；业务模块看不到它。
 * 流水线：Memory 与 segments 的 beginTick → boot（特权端口只在此期间开放）→ 普通模块 setup（Memory 首次就绪且非暂停时一次）
 * → sense/plan/arbitrate/act/move → Memory 维护与提交 → segments 提交。
 * Memory 为空时只运行 boot，跳过 setup、业务钩子、维护与提交；boot 失败的 tick 跳过 setup 与业务钩子。
 * 暂停 tick（boot 的备份尚未完成或登记了软重置）同样跳过 setup 与业务钩子，但照常提交，返回 paused，
 * 使开局判定与清空之间没有业务动作改变证据（docs/design/kernel/bootPort.md 第 3 节）。
 * 错误边界：每次钩子调用独立 try/catch；连续失败 BREAKER_THRESHOLD 次熔断，同一进程失败只记录到熔断为止；
 * setup 失败或清单校验被拒绝即初始化失败，本 global 不重试。熔断或初始化失败的模块，连同经 requires 依赖它的模块一同暂停。
 * 健康：本 tick boot 抛错、生存层任一模块不可运行，或 Memory 加载失败时为 degraded；暂停 tick 为 paused（boot 抛错优先）。
 * 由入口决定是否追加保底循环，以及是否在登记软重置后重建 kernel。
 * 状态：kernel 实例在闭包中持有模块运行记录、boot 钩子、模式视图与阶段序号，存在于一个 global；dispose 后不可再用。
 */
import type { BootContext, BootDefinition } from '@/contracts/boot';
import type { ModuleDefinition } from '@/contracts/module';
import type { BootModeView } from '@/contracts/mode';
import { createBootPort } from '@/kernel/bootPort';
import { type Breakable, type GamePort, ModuleRuntime, createCpuBudgets } from '@/kernel/context';
import { createInterShard } from '@/kernel/intershard';
import type { LogRoot } from '@/kernel/logger';
import { type MemoryOptions, createMemory } from '@/kernel/memory';
import { planModules } from '@/kernel/process';
import type { Profiler } from '@/kernel/profiler';
import { type SegmentsPlatformPort, createSegments } from '@/kernel/segments';

export type { GamePort } from '@/kernel/context';

/** 连续失败多少次熔断（附录 B）。 */
export const BREAKER_THRESHOLD = 3;

/** 业务阶段，按执行顺序。 */
const PHASES = ['sense', 'plan', 'arbitrate', 'act', 'move'] as const;

/** kernel 的健康状态，由入口据此决定是否追加保底循环；paused 为暂停 tick（见文件摘要）。 */
export type KernelHealth = 'ok' | 'degraded' | 'paused';

/** 创建 kernel 的选项。 */
export interface KernelOptions {
  readonly modules: readonly ModuleDefinition[];
  readonly boot: BootDefinition;
  /** kernel.memory 的配置；实例由 kernel 创建并管理。 */
  readonly memory: MemoryOptions;
  readonly game: GamePort;
  /** 日志根对象，由装配方按使用者设置创建。 */
  readonly logRoot: LogRoot;
  readonly profiler: Profiler;
  /** 是否对实例钩子单独计时，默认 false。 */
  readonly profileInstances?: boolean;
  /** 构建时注入的版本号，写入新建的项目标记。 */
  readonly release: string;
  /** kernel.segments 的平台端口；游戏中由 createGameSegmentsPlatform 提供。 */
  readonly segments: SegmentsPlatformPort;
  /** InterShardMemory 所在的全局对象：游戏中为 globalThis，测试中为隔离对象。 */
  readonly interShard: object;
}

/** kernel 宿主接口。 */
export interface Kernel {
  /**
   * @description 执行一个完整 tick。
   * @returns 本 tick 结束时的健康状态。
   * @throws {Error} kernel 已销毁。
   */
  tick(): KernelHealth;
  /**
   * @description boot 是否在本实例内登记了软重置；入口据此在下一 tick 前销毁并重新装配 kernel。
   * @returns 登记过为 true。
   */
  resetRequested(): boolean;
  /**
   * @description 撤销全部能力：调用实例与模块的清理函数并销毁 Memory 实例；各自独立错误边界，可重复调用。
   * @returns 无返回值。
   */
  dispose(): void;
}

/** 启动判定发布前的模式视图。 */
const INITIAL_MODE: BootModeView = Object.freeze({ mode: 'AMBIGUOUS', strength: 'medium', since: 0 });

/**
 * @description 创建 kernel：校验选项与清单，不读取游戏对象；Memory 实例在此创建但首个 tick 才加载。
 * @param options 模块清单、boot、Memory 配置、游戏端口、日志根对象与计时器。
 * @returns kernel 实例。
 * @throws {TypeError} 选项不完整（缺少 boot 或 Memory 配置等）。
 */
export const createKernel = (options: KernelOptions): Kernel => {
  if (!options.boot || typeof options.boot.setup !== 'function' || !options.memory || !options.game
    || !options.segments || !options.interShard || typeof options.release !== 'string') {
    throw new TypeError('kernel 选项不完整');
  }
  const { game, logRoot, profiler } = options;
  const log = logRoot.scope('kernel');
  const memory = createMemory(options.memory);
  const segmentsLog = logRoot.scope('segments');
  const segments = createSegments({
    platform: options.segments,
    /**
     * @description segments 的告警经 segments 作用域输出。
     * @param message 告警正文。
     * @returns 无返回值。
     */
    warn: (message) => segmentsLog.warn(message),
    bucket: game.bucket,
    /**
     * @description 当前 epoch：最近一次合法项目标记的 epoch，Memory 不可用时为 0。不读 heap 中的 sys：
     * boot 写入的非法值被隔离或提交失败时，heap 值不是已持久化的 epoch。lifecycle 先提交 Memory 再提交 segments，
     * 所以同 tick 经 sys 合法写入并提交成功的 epoch、以及同 tick 清空签发的 epoch，都在本 tick 写出的页头上生效。
     * @returns 当前 epoch。
     */
    epoch: () => memory.epoch(),
  });
  const plan = planModules(options.modules);
  const budgets = createCpuBudgets(game);
  let mode: BootModeView = INITIAL_MODE;
  let phase = 0;
  let disposed = false;
  // 本实例的普通模块是否已 setup；为 true 后不再允许清空 Memory（须先软重置）。
  let modulesSetUp = false;
  let memoryReported = false;
  let bootStreak = 0;
  let bootHooks: ReturnType<BootDefinition['setup']> | undefined;
  const services = {
    logRoot, profiler, game, memory, profileInstances: options.profileInstances ?? false,
    /**
     * @description 读取当前的启动判定结果。
     * @returns 只读模式视图。
     */
    mode: () => mode,
  };
  const runtimes = plan.order.map((def) => new ModuleRuntime(def, services, budgets, () => phase));
  // { [模块 id]: 运行记录 }，用于按 requires 查找依赖。
  const byId = new Map(runtimes.map((r) => [r.def.id, r]));
  const rejectedSurvival = options.modules.some((m) => plan.rejected.has(m.id) && m.tier === 'survival');
  for (const [id, reason] of plan.rejected) log.error(`模块 ${id} 未启动：${reason}`);

  const bootRuntime = new ModuleRuntime({ id: 'boot', tier: 'survival', priority: 0, setup: options.boot.setup as never },
    services, budgets, () => phase);
  const bootPort = createBootPort({
    memory, segments, interShard: createInterShard(options.interShard), game,
    identity: options.memory, release: options.release,
    /**
     * @description 清空的前置条件：本实例的普通模块尚未 setup。
     * @returns 尚未 setup 时为 true。
     */
    canClear: () => !modulesSetUp,
  });
  const bootContext: BootContext = Object.create(bootRuntime.ctx, {
    port: { value: bootPort.port },
    /**
     * @description 项目标记访问器；Memory 为 empty 或加载失败时抛错，清空后仍指向新标记。
     * @returns 项目标记访问器。
     */
    sys: { get: () => memory.sys() },
    setMode: {
      /**
       * @description 发布启动判定结果，所有模块经只读视图看到新的模式。
       * @param view 判定结果。
       * @returns 无返回值。
       */
      value(view: BootModeView): void { mode = Object.freeze({ mode: view.mode, strength: view.strength, since: view.since }); },
    },
  }) as BootContext;

  /**
   * @description 在独立错误边界中调用一个钩子并维护熔断计数；未熔断时每次失败都记录，熔断时记录一次。
   * @param target 进程的熔断状态。
   * @param label 日志中的进程与钩子名。
   * @param fn 钩子函数。
   * @param self 调用钩子时的 this。
   * @returns 无返回值。
   */
  const guarded = (target: Breakable, label: string, fn: () => void, self: unknown): void => {
    try {
      fn.call(self);
      target.failures = 0;
    } catch (error) {
      target.failures += 1;
      if (target.failures >= BREAKER_THRESHOLD) {
        target.broken = true;
        log.error(`${label} 连续失败 ${target.failures} 次，已熔断`, error);
      } else {
        log.error(`${label} 失败（连续 ${target.failures} 次）`, error);
      }
    }
  };

  /**
   * @description Memory 首次就绪时按执行顺序对每个模块调用一次 setup；失败的模块进入初始化失败状态。
   * @returns 无返回值。
   */
  const setupModules = (): void => {
    modulesSetUp = true;
    for (const runtime of runtimes) {
      try {
        runtime.hooks = runtime.def.setup(runtime.ctx);
      } catch (error) {
        runtime.state = 'failed';
        log.error(`模块 ${runtime.def.id} 初始化失败，本 global 内不再重试`, error);
      }
    }
  };

  /**
   * @description 依次运行五个业务阶段：每个阶段先调用模块钩子，再调用其实例的同名钩子；暂停与熔断的进程跳过。
   * 每次访问模块时重新判断能否运行：模块按拓扑顺序排列，依赖总是先被访问，所以依赖在本阶段熔断后，
   * 依赖它的模块从同一阶段起即暂停。
   * @returns 无返回值。
   */
  const runPhases = (): void => {
    for (const name of PHASES) {
      phase += 1;
      for (const runtime of runtimes) {
        runtime.runnable = runtime.state === 'ready' && !runtime.broken
          && (runtime.def.requires ?? []).every((dep) => byId.get(dep)?.runnable === true);
        if (!runtime.runnable) continue;
        const hook = runtime.hooks?.[name];
        if (hook) {
          const start = runtime.ctx.measure.begin();
          guarded(runtime, `${runtime.def.id}.${name}`, hook, runtime.hooks);
          runtime.ctx.measure.end(name, start);
        }
        if (runtime.broken) {
          // 本阶段刚熔断：立即不可运行，排在后面、依赖它的模块从同一阶段起暂停。
          runtime.runnable = false;
          continue;
        }
        for (const record of runtime.instances.values()) {
          const instanceHook = record.hooks[name];
          if (!instanceHook || record.broken || record.since >= phase) continue;
          if (services.profileInstances) {
            const timer = runtime.instance(record.key.slice(runtime.def.id.length + 1)).measure;
            const start = timer.begin();
            guarded(record, `${record.key}.${name}`, instanceHook, record.hooks);
            timer.end(name, start);
          } else {
            guarded(record, `${record.key}.${name}`, instanceHook, record.hooks);
          }
        }
      }
    }
  };

  /**
   * @description 计算本 tick 的健康状态：boot 抛错优先为 degraded，其次暂停 tick 为 paused（不计 Memory 加载失败）。
   * @param bootFailed 本 tick boot 是否抛错。
   * @param paused 本 tick 是否为暂停 tick。
   * @returns degraded、paused 或 ok。
   */
  const health = (bootFailed: boolean, paused: boolean): KernelHealth => {
    if (bootFailed) return 'degraded';
    if (paused) return 'paused';
    if (memory.failed() || rejectedSurvival) return 'degraded';
    const survivalDown = runtimes.some((r) => r.def.tier === 'survival'
      && (r.state === 'failed' || r.broken || (modulesSetUp && !r.runnable)));
    return survivalDown ? 'degraded' : 'ok';
  };

  return {
    /**
     * @description 执行一个完整 tick，语义见 Kernel.tick。
     * @returns 本 tick 结束时的健康状态。
     * @throws {Error} kernel 已销毁。
     */
    tick() {
      if (disposed) throw new Error('kernel 已销毁');
      profiler.beginTick();
      try {
        memory.beginTick({ time: game.time(), creeps: game.creepNames(), flags: game.flagNames() });
      } catch (error) {
        if (!memoryReported) log.error('Memory 不可用，本 global 内所有模块都无法读写持久数据', error);
        memoryReported = true;
      }
      try { segments.beginTick(); } catch (error) { log.error('segment 读取失败', error); }
      let bootFailed = false;
      try {
        bootHooks ??= options.boot.setup(bootContext);
        const hooks = bootHooks;
        bootPort.run(() => hooks.boot());
        if (bootStreak > 0) log.info(`boot 恢复（此前连续失败 ${bootStreak} 次）`);
        bootStreak = 0;
      } catch (error) {
        bootFailed = true;
        bootStreak += 1;
        if (bootStreak === 1) log.error('boot 失败，本 tick 跳过业务钩子；连续失败期间不再重复记录', error);
      }
      const ready = memory.ready();
      const paused = bootPort.paused();
      if (ready && !bootFailed && !paused && !modulesSetUp) setupModules();
      if (ready && !bootFailed && !paused) runPhases();
      if (ready) {
        try { memory.maintain(); } catch (error) { log.error('Memory 维护失败', error); }
        try { memory.commit(); } catch (error) { log.error('Memory 提交失败，下一 tick 重试', error); }
      }
      // 与 Memory 状态无关：Memory 加载失败时备份页同样要写出。
      try { segments.commit(); } catch (error) { log.error('segment 提交失败', error); }
      return health(bootFailed, paused);
    },
    /**
     * @description 是否登记了软重置，语义见 Kernel.resetRequested。
     * @returns 登记过为 true。
     */
    resetRequested: () => bootPort.resetRequested(),
    /**
     * @description 撤销全部能力，语义见 Kernel.dispose。
     * @returns 无返回值。
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const runtime of runtimes) {
        for (const record of runtime.instances.values()) {
          try { record.hooks.dispose?.(); } catch (error) { log.error(`实例 ${record.key} 清理失败`, error); }
        }
        for (const fn of runtime.disposers) {
          try { fn(); } catch (error) { log.error(`模块 ${runtime.def.id} 清理失败`, error); }
        }
      }
      try { memory.dispose(); } catch (error) { log.error('Memory 销毁失败', error); }
    },
  };
};
