/**
 * 文件摘要：kernel.lifecycle，kernel 的宿主接口与 tick 流水线（设计见 docs/design/kernel/README.md 第 1–3 节）。
 *
 * 所属位置：src/kernel/lifecycle/，kernel 的唯一对外入口，只由 app.assembly 与 main.ts 使用；业务模块看不到它。
 * 流水线：cpu 预算 → Memory 与 segments 的 beginTick → boot（特权端口只在此期间开放）→ 普通模块 setup
 * （Memory 首次就绪且非暂停时一次）→ 启停标志刷新与 CPU 准入 → sense/plan/arbitrate/act/move → cpu 计量收尾 →
 * Memory 维护与提交 → stats → segments 提交。
 * Memory 为空，或本 tick 的 beginTick 在更新 tick 事实之前失败（tick 倒退等）时只运行 boot，跳过 setup、业务钩子、
 * 维护与提交；boot 失败的 tick 跳过 setup 与业务钩子。
 * 暂停 tick（boot 的备份尚未完成或登记了软重置）同样跳过 setup 与业务钩子，但照常提交，返回 paused，
 * 使开局判定与清空之间没有业务动作改变证据（docs/design/kernel/bootPort.md 第 3 节）。
 * CPU（docs/design/kernel/cpu.md）：准入在本 tick 内固定，只有被准入的进程运行；阶段循环在相邻钩子之间只读一次
 * Game.cpu.getUsed()，前一个钩子的结束读数就是后一个的开始读数；读数到达 hardEnd 后跳过剩余的非生存层钩子（紧急刹车），
 * 被跳过的进程经 cpu.brake 改记为落选，不记样本、连续落选次数加 1。
 * 错误边界：每次钩子调用独立 try/catch；连续失败 BREAKER_THRESHOLD 次熔断，同一进程失败只记录到熔断为止；
 * setup 失败或清单校验被拒绝即初始化失败，本 global 不重试。熔断、初始化失败或运维暂停的模块，
 * 连同经 requires 依赖它的模块一同暂停。
 * 健康：本 tick boot 抛错、生存层任一模块不可运行、Memory 加载失败，或本 tick 的 beginTick 如上失败时为 degraded；
 * 暂停 tick 为 paused（boot 抛错优先）。
 * 由入口决定是否追加保底循环，以及是否在登记软重置后重建 kernel。
 * 状态：kernel 实例在闭包中持有模块运行记录、boot 钩子、模式视图、阶段序号、cpu、console、stats 与启停标志，
 * 存在于一个 global；dispose 后不可再用，控制台命名空间换为桩对象。
 */
import type { BootContext, BootDefinition } from '@/contracts/boot';
import type { ModuleDefinition } from '@/contracts/module';
import type { BootModeView } from '@/contracts/mode';
import { createBootPort } from '@/kernel/bootPort';
import { type ConsoleHost, type HostConsoleRegistry, createConsole } from '@/kernel/console';
import { type Breakable, type GamePort, ModuleRuntime } from '@/kernel/context';
import { type CpuNode, VERDICT_ADMIT, VERDICT_NONE, createCpu } from '@/kernel/cpu';
import { createInterShard } from '@/kernel/intershard';
import type { LogRoot } from '@/kernel/logger';
import { type MemoryOptions, createMemory } from '@/kernel/memory';
import { BOOT_ID, planModules } from '@/kernel/process';
import type { Profiler } from '@/kernel/profiler';
import { type SegmentsPlatformPort, createSegments } from '@/kernel/segments';
import { STATS_VERSION, type StatsSnapshot, createStats } from '@/kernel/stats';
import { type KernelOps, buildStatsSnapshot, createKernelOps, createSwitches } from './ops';

export type { GamePort } from '@/kernel/context';
export type { KernelOps, KernelStatus, ModuleStatus, ModuleStatusState, Switch } from './ops';

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
  /** 控制台命名空间的安装目标：游戏中为 globalThis，测试中为隔离对象。 */
  readonly console: object;
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
  /** 宿主侧运维接口，供 app.ops 使用（docs/design/app/ops.md 第 4 节）。 */
  readonly ops: KernelOps;
  /**
   * @description 为 app 层取得控制台命名空间的注册器（含离线命令），例如 app.ops 的 ops。
   * @param namespace 宿主命名空间；不得与模块 id 或 boot 相同。
   * @returns 注册器。
   * @throws {TypeError} 命名空间与模块 id 冲突。
   */
  console(namespace: string): HostConsoleRegistry;
  /**
   * @description 撤销全部能力：调用实例与模块的清理函数、销毁 Memory 实例，并把控制台命名空间换为桩对象；
   * 各自独立错误边界，可重复调用。
   * @returns 无返回值。
   */
  dispose(): void;
}

/** 启动判定发布前的模式视图。 */
const INITIAL_MODE: BootModeView = Object.freeze({ mode: 'AMBIGUOUS', strength: 'medium', since: 0 });

/**
 * @description 创建 kernel：校验选项与清单，不读取游戏对象；Memory 实例在此创建但首个 tick 才加载。
 * @param options 模块清单、boot、Memory 配置、游戏端口、日志根对象、计时器与平台注入。
 * @returns kernel 实例。
 * @throws {TypeError} 选项不完整（缺少 boot 或 Memory 配置等）。
 */
export const createKernel = (options: KernelOptions): Kernel => {
  if (!options.boot || typeof options.boot.setup !== 'function' || !options.memory || !options.game
    || !options.segments || !options.interShard || !options.console || typeof options.release !== 'string') {
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
  const statsLog = logRoot.scope('stats');
  const stats = createStats({
    writer: segments.writer('stats', STATS_VERSION),
    /**
     * @description stats 的告警经 stats 作用域输出。
     * @param message 告警正文。
     * @returns 无返回值。
     */
    warn: (message) => statsLog.warn(message),
  });
  const cpu = createCpu(game);
  const plan = planModules(options.modules);
  let mode: BootModeView = INITIAL_MODE;
  let phase = 0;
  let disposed = false;
  // 本实例的普通模块是否已 setup；为 true 后不再允许清空 Memory（须先软重置）。
  let modulesSetUp = false;
  let memoryReported = false;
  // boot 与 Memory 提交的连续失败次数：只在连续失败开始时记录，恢复时报告次数。
  let bootStreak = 0;
  let commitStreak = 0;
  let bootHooks: ReturnType<BootDefinition['setup']> | undefined;
  let lastHealth: KernelHealth | undefined;
  // { [模块 id]: 运行记录 }，用于按 requires 查找依赖、运维命令与控制台日志；boot 不在其中。
  const byId = new Map<string, ModuleRuntime>();
  let bootRuntime: ModuleRuntime | undefined;
  const consoleHost: ConsoleHost = createConsole({
    target: options.console,
    /**
     * @description 命名空间的日志：模块与 boot 用其上下文日志，宿主命名空间按名称派生。
     * @param namespace 命名空间。
     * @returns Logger。
     */
    logger: (namespace) => (namespace === BOOT_ID ? bootRuntime?.ctx.log : byId.get(namespace)?.ctx.log)
      ?? logRoot.scope(namespace),
  });
  const services = {
    logRoot, profiler, game, memory, profileInstances: options.profileInstances ?? false, console: consoleHost,
    /**
     * @description 读取当前的启动判定结果。
     * @returns 只读模式视图。
     */
    mode: () => mode,
  };
  const runtimes = plan.order.map((def) => new ModuleRuntime(def, services, cpu.budgets, () => phase));
  for (const runtime of runtimes) byId.set(runtime.def.id, runtime);
  // requires 已由清单规划校验存在且无环；依赖总是排在依赖方之前。
  for (const runtime of runtimes) for (const dep of runtime.def.requires ?? []) runtime.deps.push(byId.get(dep)!);
  const rejectedSurvival = options.modules.some((m) => plan.rejected.has(m.id) && m.tier === 'survival');
  for (const [id, reason] of plan.rejected) log.error(`模块 ${id} 未启动：${reason}`);
  const switches = createSwitches({ memory, byId, log });
  // 本 tick 参与准入的进程，按执行顺序（模块在前、其实例随后）；数组跨 tick 复用，避免每 tick 分配。
  const nodes: CpuNode[] = [];

  bootRuntime = new ModuleRuntime({ id: BOOT_ID, tier: 'survival', priority: 0, setup: options.boot.setup as never },
    services, cpu.budgets, () => phase);
  const bootPort = createBootPort({
    memory, segments, interShard: createInterShard(options.interShard), game,
    identity: options.memory, release: options.release,
    /**
     * @description 清空的前置条件：本实例的普通模块尚未 setup。
     * @returns 尚未 setup 时为 true。
     */
    canClear: () => !modulesSetUp,
  });
  // boot 不经进程表调度：遮蔽继承来的 processes 与 instance，误用时立即抛 TypeError，而不是添加永不运行的实例。
  const bootContext: BootContext = Object.create(bootRuntime.ctx, {
    processes: { value: undefined },
    instance: { value: undefined },
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
   * @description 在独立错误边界中调用一个钩子并维护熔断计数；未熔断时每次失败都记录，熔断时记录一次并计入统计。
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
        stats.breaker();
        log.error(`${label} 连续失败 ${target.failures} 次，已熔断`, error);
      } else {
        log.error(`${label} 失败（连续 ${target.failures} 次）`, error);
      }
    }
  };

  /**
   * @description Memory 首次就绪时取得启停标志分区，再按执行顺序对每个模块调用一次 setup；失败的模块进入初始化失败状态。
   * 运维暂停的模块同样 setup：setup 只在 global 内执行一次，暂停期间不执行就无法在恢复时补做。
   * @returns 无返回值。
   */
  const setupModules = (): void => {
    modulesSetUp = true;
    try { switches.attach(); } catch (error) { log.error('启停标志分区不可用，按清单默认值运行', error); }
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
   * @description 判断模块此刻能否运行：已就绪、未熔断、未暂停，且 requires 的模块都可运行（依赖排在前面，已先计算）。
   * @param runtime 模块运行记录。
   * @returns 可运行时为 true。
   */
  const canRun = (runtime: ModuleRuntime): boolean => runtime.state === 'ready' && !runtime.broken && !runtime.paused
    && runtime.deps.every((dep) => dep.runnable);

  /**
   * @description 准入前刷新启停标志与可运行状态，并按执行顺序重建本 tick 的进程列表。
   * @returns 无返回值。
   */
  const prepare = (): void => {
    switches.refresh();
    nodes.length = 0;
    for (const runtime of runtimes) {
      runtime.runnable = canRun(runtime);
      nodes.push(runtime);
      for (const record of runtime.instances.values()) {
        record.runnable = runtime.runnable && !record.broken;
        nodes.push(record);
      }
    }
  };

  /**
   * @description 依次运行五个业务阶段：每个阶段先调用模块钩子，再调用其实例的同名钩子；只运行被准入的进程。
   * 每次访问模块时重新判断能否运行：模块按拓扑顺序排列，依赖在本阶段熔断后，依赖它的模块从同一阶段起即暂停。
   * 模块不可运行（熔断、初始化失败、暂停或依赖不可运行）时连同实例一起跳过；模块可运行时，模块钩子与实例钩子
   * 各按自己的判定结果执行（cpu.md 第 3.1 节）：维护层的模块与实例按各自的进程键错峰，模块空闲的 tick 实例仍可运行；
   * 模块落选时 kernel.cpu 已把实例判为落选。
   * 本 tick 新增的实例没有判定结果，按预热规则视为准入（cpu.md 第 3.2 节），从下一个阶段开始参与调度。
   * 计量：相邻钩子之间只读一次 CPU，差值计入进程的 spent；读数到达 hardEnd 时跳过剩余的非生存层钩子。
   * @returns 无返回值。
   */
  const runPhases = (): void => {
    const hardEnd = cpu.hardEnd();
    let braked = false;
    /**
     * @description 判断非生存层钩子是否因读数到达 hardEnd 而跳过；首次触发时记录一次告警。
     * @param reading 当前读数。
     * @returns 应跳过时为 true。
     */
    const brake = (reading: number): boolean => {
      if (reading < hardEnd) return false;
      if (!braked) log.warn(`CPU 读数到达上限 ${hardEnd.toFixed(1)}，本 tick 跳过剩余的非生存层钩子`);
      braked = true;
      return true;
    };
    for (const name of PHASES) {
      phase += 1;
      let last = game.cpuUsed();
      for (const runtime of runtimes) {
        runtime.runnable = canRun(runtime);
        if (!runtime.runnable) continue;
        const survival = runtime.tier === 'survival';
        if (runtime.verdict === VERDICT_ADMIT) {
          const hook = runtime.hooks?.[name];
          // 被刹车跳过的进程改记为落选（ultrareview 第 3 项）：不记样本、不计准入，下一 tick 优先；
          // 它的实例随后在实例循环中逐个跳过并记录。
          if (hook && !survival && brake(last)) {
            cpu.brake(runtime);
          } else if (hook) {
            guarded(runtime, `${runtime.def.id}.${name}`, hook, runtime.hooks);
            runtime.ctx.measure.end(name, last);
            const now = game.cpuUsed();
            runtime.spent += now - last;
            last = now;
          }
          if (runtime.broken) {
            // 本阶段刚熔断：立即不可运行，排在后面、依赖它的模块从同一阶段起暂停。
            runtime.runnable = false;
            continue;
          }
        }
        for (const record of runtime.instances.values()) {
          const instanceHook = record.hooks[name];
          if (!instanceHook || record.broken || record.since >= phase) continue;
          if (record.verdict !== VERDICT_ADMIT && record.verdict !== VERDICT_NONE) continue;
          if (!survival && brake(last)) { cpu.brake(record); continue; }
          guarded(record, `${record.key}.${name}`, instanceHook, record.hooks);
          record.measure?.end(name, last);
          const now = game.cpuUsed();
          record.spent += now - last;
          last = now;
        }
      }
    }
  };

  /**
   * @description 计算本 tick 的健康状态：boot 抛错优先为 degraded，其次暂停 tick 为 paused（不计 Memory 加载失败）。
   * 运维暂停只发生在非生存层（ops.md 第 3.2 节），不影响健康状态。
   * @param bootFailed 本 tick boot 是否抛错。
   * @param paused 本 tick 是否为暂停 tick。
   * @param memoryStale 本 tick Memory 的 beginTick 是否在更新 tick 事实之前失败（tick 倒退、接管过晚）。
   * @returns degraded、paused 或 ok。
   */
  const health = (bootFailed: boolean, paused: boolean, memoryStale: boolean): KernelHealth => {
    if (bootFailed) return 'degraded';
    if (paused) return 'paused';
    if (memoryStale || memory.failed() || rejectedSurvival) return 'degraded';
    const survivalDown = runtimes.some((r) => r.def.tier === 'survival'
      && (r.state === 'failed' || r.broken || (modulesSetUp && !r.runnable)));
    return survivalDown ? 'degraded' : 'ok';
  };

  const ops = createKernelOps({
    byId, runtimes, switches, cpu, memory, release: options.release,
    /**
     * @description 当前模式视图。
     * @returns 模式视图。
     */
    mode: () => mode,
    /**
     * @description 最近一次 tick 的健康状态。
     * @returns 健康状态；尚未运行过时为 undefined。
     */
    health: () => lastHealth,
    /**
     * @description 普通模块是否已 setup。
     * @returns 已 setup 时为 true。
     */
    setUp: () => modulesSetUp,
    /**
     * @description 当前 tick。
     * @returns Game.time。
     */
    time: game.time,
  });

  /**
   * @description 生成统计页的状态快照，只在窗口写出时调用一次。
   * @returns 状态快照。
   */
  const statsSnapshot = (): StatsSnapshot => buildStatsSnapshot({ runtimes, memory, segments, release: options.release, mode });

  return {
    ops,
    /**
     * @description 执行一个完整 tick，语义见 Kernel.tick。
     * @returns 本 tick 结束时的健康状态。
     * @throws {Error} kernel 已销毁。
     */
    tick() {
      if (disposed) throw new Error('kernel 已销毁');
      profiler.beginTick();
      cpu.beginTick();
      // 加载失败时 beginTick 已更新 tick 事实与提交状态，失败锁存，ready() 为 false，boot 可在本 tick 清空后照常提交。
      // 其他失败（tick 倒退、接管过晚）发生在更新之前、不锁存：ready() 仍为 true，但本 tick 的修改无法正确提交，
      // 所以本 tick 按 Memory 不可用处理（stale），跳过 setup、业务钩子、维护与提交，计为 degraded（内核设计第 2 节）。
      // 同一段连续失败只记录一次，恢复时记录一次。
      let memoryStale = false;
      try {
        memory.beginTick({ time: game.time(), creeps: game.creepNames(), flags: game.flagNames() });
        if (memoryReported) log.info('Memory 恢复可用');
        memoryReported = false;
      } catch (error) {
        memoryStale = !memory.failed();
        if (!memoryReported) {
          log.error(memoryStale ? 'Memory 本 tick 无法开始，跳过模块 setup、业务钩子、维护与提交，直到恢复'
            : 'Memory 不可用，本 global 内所有模块都无法读写持久数据', error);
        }
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
      const ready = !memoryStale && memory.ready();
      const paused = bootPort.paused();
      if (ready && !bootFailed && !paused && !modulesSetUp) setupModules();
      if (ready && !bootFailed && !paused) {
        prepare();
        cpu.admit(nodes);
        runPhases();
        cpu.settle(nodes);
      } else {
        // 不运行业务阶段的 tick 没有进程耗用；摘要只保留本 tick 的预算。
        cpu.settle([]);
      }
      // kernel 收尾（Memory 维护与提交）的起点读数；与统计采集时的读数相减，得到 cpu.finish（stats 设计第 2 节），
      // 供 14.4 候选优化的触发条件判断。每 tick 多一次 getUsed()。
      const finishStart = game.cpuUsed();
      if (ready) {
        // Memory 维护是收尾工作，不参与分层准入（cpu.md 第 3.3 节）；单次成本受每 tick 记录上限约束。
        try { memory.maintain(); } catch (error) { log.error('Memory 维护失败', error); }
        // 提交失败保留脏状态，下一 tick 重试；持续失败（例如超过体积上限）时只在连续失败开始时记录一次，
        // 恢复时记录一次，避免每 tick 刷日志（审计 PA-17）。
        try {
          memory.commit();
          if (commitStreak > 0) log.info(`Memory 提交恢复（此前连续失败 ${commitStreak} 次）`);
          commitStreak = 0;
        } catch (error) {
          commitStreak += 1;
          if (commitStreak === 1) log.error('Memory 提交失败，下一 tick 重试；连续失败期间不再重复记录', error);
        }
      }
      const result = health(bootFailed, paused, memoryStale);
      lastHealth = result;
      try {
        const summary = cpu.summary();
        const used = game.cpuUsed();
        stats.record({ time: game.time(), cpu: used, finish: used - finishStart, budget: summary.budget, reserve: summary.reserve,
          tiers: summary.tiers, admitted: summary.admitted, rejected: summary.rejected, bucket: game.bucket(), health: result },
        statsSnapshot);
      } catch (error) { log.error('统计采集失败', error); }
      // 与 Memory 状态无关：Memory 加载失败时备份页同样要写出。
      try { segments.commit(); } catch (error) { log.error('segment 提交失败', error); }
      return result;
    },
    /**
     * @description 是否登记了软重置，语义见 Kernel.resetRequested。
     * @returns 登记过为 true。
     */
    resetRequested: () => bootPort.resetRequested(),
    /**
     * @description 取得宿主命名空间的注册器，语义见 Kernel.console。
     * @param namespace 宿主命名空间。
     * @returns 注册器。
     * @throws {TypeError} 与模块 id 或 boot 冲突。
     */
    console(namespace) {
      if (namespace === BOOT_ID || byId.has(namespace)) throw new TypeError(`控制台命名空间 ${namespace} 属于模块`);
      return consoleHost.registry(namespace);
    },
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
      // boot 的运行记录不在 runtimes 中，它经 onDispose 登记的清理函数单独调用（contracts BootContext）。
      for (const fn of bootRuntime!.disposers) {
        try { fn(); } catch (error) { log.error('boot 清理失败', error); }
      }
      try { consoleHost.dispose(); } catch (error) { log.error('控制台命名空间清理失败', error); }
      try { memory.dispose(); } catch (error) { log.error('Memory 销毁失败', error); }
    },
  };
};
