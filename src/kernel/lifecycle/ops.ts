/**
 * 文件摘要：kernel.lifecycle 的运维面：模块启停标志（架构 5.5）与宿主侧运维接口 KernelOps
 * （设计见 docs/design/app/ops.md 第 3、4 节）。
 *
 * 启停标志存于 kernel 自己的分区 part.kernel.switches，内容为 { [模块 id]: 'pause' | 'run' }，只记录运维覆盖；
 * 没有记录的模块取清单的 startPaused。每 tick 准入前 refresh 一次，计算每个模块的 paused；生存层恒不暂停。
 * 暂停只跳过钩子（不参与准入），不释放实例、不重新 setup。
 * KernelOps 供 app.ops 使用：状态快照、修改开关、恢复熔断、取得进程的 Logger；它只调用本文件与运行记录，
 * 不向 app 暴露 kernel 的实现对象。统计页的状态快照（buildStatsSnapshot）也在这里生成，与状态快照读取同一批运行记录。
 * 状态：分区访问器在 Memory 首次就绪、普通模块 setup 之前取得（attach），随 kernel 实例存在；
 * 已告警的记录键保存在闭包中，每个键只告警一次。
 */
import type { Tier } from '@/contracts/cpu';
import type { Logger } from '@/contracts/log';
import type { Accessor, UnitSpec } from '@/contracts/memory';
import type { BootModeView } from '@/contracts/mode';
import type { Breakable, MemoryHost, ModuleRuntime } from '@/kernel/context';
import type { CpuHost } from '@/kernel/cpu';
import type { SegmentsHost } from '@/kernel/segments';
import { STATS_TOP, type StatsSnapshot } from '@/kernel/stats';

/** 一个模块的运维覆盖：暂停或运行。 */
export type Switch = 'pause' | 'run';
/** 启停标志分区：{ [模块 id]: 运维覆盖 }。 */
export type Switches = { [id: string]: Switch };

/** kernel 分区的 owner 与启停标志的分区名；owner 是保留模块 id（kernel.process 的 RESERVED_MODULE_IDS）。 */
export const KERNEL_OWNER = 'kernel';
export const SWITCHES_ID = 'switches';

/** 启停标志分区的声明；Memory 要求同一身份始终使用同一 spec 对象，所以是模块级常量。 */
const SWITCHES_SPEC: UnitSpec<Switches> = Object.freeze({
  version: 1,
  /**
   * @description 首次安装时没有任何覆盖。
   * @returns 空对象。
   */
  initialize: (): Switches => ({}),
  /**
   * @description 版本 1 是唯一版本；其他版本（回滚到旧代码等）的内容只可能是同样的形状，原样保留。
   * @param data 已存数据的副本。
   * @returns 数据。
   */
  migrate: (data: unknown): Switches => data as Switches,
});

/** 模块的运维状态（ops.status 显示）。 */
export type ModuleStatusState = 'pending' | 'running' | 'paused' | 'blocked' | 'broken' | 'failed';

/** 一个模块的状态。 */
export interface ModuleStatus {
  readonly id: string;
  readonly tier: Tier;
  /** pending 为尚未 setup；blocked 为 requires 的依赖不可运行。 */
  readonly state: ModuleStatusState;
  /** 运维覆盖；没有覆盖时为 undefined。 */
  readonly switch: Switch | undefined;
  readonly startPaused: boolean;
  /** 平滑耗用；没有样本时为 undefined。 */
  readonly cost: number | undefined;
  readonly starve: number;
  readonly instances: number;
  readonly brokenInstances: number;
}

/** kernel 的状态快照：最近一次 tick 结束时的状态。 */
export interface KernelStatus {
  readonly tick: number;
  /** 最近一次 tick 的健康状态；尚未运行过时为 undefined。 */
  readonly health: 'ok' | 'degraded' | 'paused' | undefined;
  readonly mode: BootModeView;
  readonly release: string;
  readonly memory: 'ready' | 'empty' | 'failed';
  readonly budget: number;
  readonly reserve: number;
  readonly modules: readonly ModuleStatus[];
}

/** 宿主侧运维接口，供 app.ops 使用（ops.md 第 4 节）。 */
export interface KernelOps {
  /**
   * @description 取得状态快照；控制台命令在主循环之后运行，读到的是本 tick 结束时的状态。
   * @returns 状态快照。
   */
  status(): KernelStatus;
  /**
   * @description 修改一个模块的运维覆盖，下一 tick 生效。
   * @param id 模块 id。
   * @param value pause 或 run；undefined 清除覆盖、恢复清单默认值。
   * @returns 无返回值。
   * @throws {Error} 未知模块、生存层模块，或 Memory 不可用（empty、加载失败、普通模块尚未 setup）。
   */
  setSwitch(id: string, value: Switch | undefined): void;
  /**
   * @description 清除进程的熔断状态与失败计数，保留钩子与上下文，不重新 setup。
   * @param key 模块 id 或完整进程键 `<模块 id>:<实例键>`。
   * @returns 无返回值。
   * @throws {Error} 未知进程，或模块初始化失败（须软重置或新的 global）。
   */
  recover(key: string): void;
  /**
   * @description 取得进程的 Logger，供运维修改作用域的日志覆盖值。
   * @param key 模块 id 或完整进程键。
   * @returns Logger。
   * @throws {Error} 未知进程。
   */
  logger(key: string): Logger;
}

/** 启停标志的宿主接口。 */
export interface SwitchesHost {
  /**
   * @description Memory 首次就绪、普通模块 setup 之前取得分区访问器。
   * @returns 无返回值。
   * @throws {Error} 分区申请失败（Memory 的错误原样传播）。
   */
  attach(): void;
  /**
   * @description 每 tick 准入前计算每个模块的 paused；记录了生存层或未知模块时各告警一次。
   * @returns 无返回值。
   */
  refresh(): void;
  /**
   * @description 读取一个模块的运维覆盖。
   * @param id 模块 id。
   * @returns 覆盖；没有记录或尚未 attach 时为 undefined。
   */
  value(id: string): Switch | undefined;
  /**
   * @description 写入或清除一个模块的运维覆盖，语义见 KernelOps.setSwitch。
   * @param id 模块 id。
   * @param value 覆盖；undefined 清除。
   * @returns 无返回值。
   * @throws {Error} 见 KernelOps.setSwitch。
   */
  set(id: string, value: Switch | undefined): void;
}

/**
 * @description 创建启停标志的宿主；构造不访问 Memory。
 * @param deps Memory、模块运行记录与告警日志。
 * @param deps.memory kernel.memory 宿主实例。
 * @param deps.byId { [模块 id]: 运行记录 }。
 * @param deps.log kernel 作用域的日志。
 * @returns 宿主接口。
 */
export const createSwitches = (deps: {
  readonly memory: MemoryHost;
  readonly byId: ReadonlyMap<string, ModuleRuntime>;
  readonly log: Logger;
}): SwitchesHost => {
  let switches: Accessor<Switches> | undefined;
  // 已告警的记录键：生存层的 pause 记录与未知模块 id，每个只告警一次。
  const warned = new Set<string>();

  /**
   * @description 读取当前的覆盖表；尚未 attach 或 Memory 不可用时为 undefined。
   * @returns 覆盖表的只读原引用。
   */
  const table = (): Readonly<Switches> | undefined => {
    if (!switches || !deps.memory.ready()) return undefined;
    return switches.root() as Readonly<Switches>;
  };

  return {
    /**
     * @description 取得分区访问器，语义见 SwitchesHost.attach。
     * @returns 无返回值。
     */
    attach() { switches ??= deps.memory.partitions(KERNEL_OWNER).partition<Switches>(SWITCHES_ID, SWITCHES_SPEC); },
    /**
     * @description 计算 paused，语义见 SwitchesHost.refresh。
     * @returns 无返回值。
     */
    refresh() {
      const data = table();
      for (const runtime of deps.byId.values()) {
        const value = data?.[runtime.def.id];
        if (runtime.def.tier === 'survival') {
          runtime.paused = false;
          if (value === 'pause' && !warned.has(runtime.def.id)) {
            warned.add(runtime.def.id);
            deps.log.warn(`生存层模块 ${runtime.def.id} 不能暂停，已忽略启停标志中的 pause 记录`);
          }
        } else {
          runtime.paused = value === 'pause' || (value === undefined && runtime.def.startPaused === true);
        }
      }
      if (!data) return;
      for (const id of Object.keys(data)) {
        if (!deps.byId.has(id) && !warned.has(id)) {
          warned.add(id);
          deps.log.warn(`启停标志中记录了未知模块 ${id}，已忽略（不删除，避免装配暂时缺少该模块时丢失运维意图）`);
        }
      }
    },
    /**
     * @description 读取运维覆盖，语义见 SwitchesHost.value。
     * @param id 模块 id。
     * @returns 覆盖。
     */
    value: (id) => {
      const value = table()?.[id];
      return value === 'pause' || value === 'run' ? value : undefined;
    },
    /**
     * @description 写入或清除运维覆盖，语义见 SwitchesHost.set。
     * @param id 模块 id。
     * @param value 覆盖。
     * @returns 无返回值。
     * @throws {Error} 未知模块、生存层模块或 Memory 不可用。
     */
    set(id, value) {
      const runtime = deps.byId.get(id);
      if (!runtime) throw new Error(`未知模块 ${id}`);
      if (runtime.def.tier === 'survival') throw new Error(`${id} 是生存层模块，不能暂停；需要停用时应通过发布或回滚`);
      if (!switches || !deps.memory.ready()) throw new Error('Memory 不可用（empty、加载失败或普通模块尚未 setup），启停标志无法写入');
      if (value === undefined) switches.delete([id]);
      else switches.set([id], value);
    },
  };
};

/**
 * @description 计算一个模块的运维状态。
 * @param runtime 运行记录。
 * @param setUp 普通模块是否已 setup。
 * @returns 状态。
 */
export const moduleState = (runtime: ModuleRuntime, setUp: boolean): ModuleStatusState => {
  if (runtime.state === 'failed') return 'failed';
  if (!setUp) return 'pending';
  if (runtime.broken) return 'broken';
  if (runtime.paused) return 'paused';
  return runtime.runnable ? 'running' : 'blocked';
};

/**
 * @description 按模块 id 或完整进程键查找运行记录。
 * @param byId { [模块 id]: 运行记录 }。
 * @param key 模块 id 或 `<模块 id>:<实例键>`。
 * @returns 模块记录，以及实例键（key 为模块 id 时为 undefined）。
 * @throws {Error} 未知模块或实例。
 */
export const resolveProcess = (byId: ReadonlyMap<string, ModuleRuntime>, key: string):
  { readonly runtime: ModuleRuntime; readonly instance: string | undefined } => {
  const colon = key.indexOf(':');
  const id = colon < 0 ? key : key.slice(0, colon);
  const runtime = byId.get(id);
  if (!runtime) throw new Error(`未知进程 ${key}`);
  if (colon < 0) return { runtime, instance: undefined };
  const instance = key.slice(colon + 1);
  if (!runtime.instances.has(instance)) throw new Error(`未知进程 ${key}`);
  return { runtime, instance };
};

/** createKernelOps 的依赖，由 lifecycle 注入。 */
export interface KernelOpsDeps {
  /** { [模块 id]: 运行记录 }。 */
  readonly byId: ReadonlyMap<string, ModuleRuntime>;
  /** 运行记录，按执行顺序。 */
  readonly runtimes: readonly ModuleRuntime[];
  readonly switches: SwitchesHost;
  readonly cpu: CpuHost;
  readonly memory: MemoryHost;
  readonly release: string;
  /**
   * @description 当前模式视图。
   * @returns 模式视图。
   */
  mode(): BootModeView;
  /**
   * @description 最近一次 tick 的健康状态。
   * @returns 健康状态；尚未运行过时为 undefined。
   */
  health(): KernelStatus['health'];
  /**
   * @description 普通模块是否已 setup。
   * @returns 已 setup 时为 true。
   */
  setUp(): boolean;
  /**
   * @description 当前 tick。
   * @returns Game.time。
   */
  time(): number;
}

/**
 * @description 创建宿主侧运维接口，语义见 KernelOps；每次调用读取当时的运行记录，不缓存快照。
 * @param deps 运行记录、启停标志、cpu、Memory 与 lifecycle 的状态读取函数。
 * @returns 运维接口。
 */
export const createKernelOps = (deps: KernelOpsDeps): KernelOps => ({
  /**
   * @description 状态快照，语义见 KernelOps.status。
   * @returns 状态快照。
   */
  status(): KernelStatus {
    const summary = deps.cpu.summary();
    const setUp = deps.setUp();
    return {
      tick: deps.time(), health: deps.health(), mode: deps.mode(), release: deps.release,
      memory: deps.memory.ready() ? 'ready' : deps.memory.failed() ? 'failed' : 'empty',
      budget: summary.budget, reserve: summary.reserve,
      modules: deps.runtimes.map((r) => {
        let brokenInstances = 0;
        for (const record of r.instances.values()) if (record.broken) brokenInstances += 1;
        return {
          id: r.def.id, tier: r.def.tier, state: moduleState(r, setUp), switch: deps.switches.value(r.def.id),
          startPaused: r.def.startPaused === true, cost: r.sampled ? r.cost : undefined, starve: r.starve,
          instances: r.instances.size, brokenInstances,
        };
      }),
    };
  },
  /**
   * @description 修改运维覆盖，语义见 KernelOps.setSwitch。
   * @param id 模块 id。
   * @param value 覆盖。
   * @returns 无返回值。
   * @throws {Error} 未知模块、生存层模块或 Memory 不可用。
   */
  setSwitch: (id, value) => deps.switches.set(id, value),
  /**
   * @description 清除熔断，语义见 KernelOps.recover。
   * @param key 模块 id 或完整进程键。
   * @returns 无返回值。
   * @throws {Error} 未知进程或模块初始化失败。
   */
  recover(key) {
    const { runtime, instance } = resolveProcess(deps.byId, key);
    if (instance === undefined && runtime.state === 'failed') {
      throw new Error(`${key} 初始化失败，不能就地恢复，须软重置或新的 global`);
    }
    const target: Breakable = instance === undefined ? runtime : runtime.instances.get(instance)!;
    target.broken = false;
    target.failures = 0;
  },
  /**
   * @description 取得进程的 Logger，语义见 KernelOps.logger。
   * @param key 模块 id 或完整进程键。
   * @returns Logger。
   * @throws {Error} 未知进程。
   */
  logger(key) {
    const { runtime, instance } = resolveProcess(deps.byId, key);
    return instance === undefined ? runtime.ctx.log : runtime.instance(instance).log;
  },
});

/**
 * @description 生成统计页的状态快照（stats 设计第 2 节）：平滑耗用最高的进程、熔断与暂停的模块、Memory 体积与待写页数。
 * 只在统计窗口写出时调用，成本为 O(进程数 × log)。
 * @param deps 运行记录、Memory、segments、版本号与模式。
 * @param deps.runtimes 运行记录。
 * @param deps.memory kernel.memory 宿主实例。
 * @param deps.segments segments 宿主（只读待写页数）。
 * @param deps.release 版本号。
 * @param deps.mode 当前模式视图。
 * @returns 状态快照。
 */
export const buildStatsSnapshot = (deps: { readonly runtimes: readonly ModuleRuntime[]; readonly memory: MemoryHost;
  readonly segments: Pick<SegmentsHost, 'pending'>; readonly release: string; readonly mode: BootModeView }): StatsSnapshot => {
  const sampled: (readonly [string, number])[] = [];
  for (const runtime of deps.runtimes) {
    if (runtime.sampled) sampled.push([runtime.key, runtime.cost]);
    for (const record of runtime.instances.values()) if (record.sampled) sampled.push([record.key, record.cost]);
  }
  sampled.sort((a, b) => b[1] - a[1]);
  let memory: StatsSnapshot['memory'] = null;
  if (deps.memory.ready()) {
    const sizes = deps.memory.sizes();
    memory = { total: sizes.total, spaces: sizes.spaces };
  }
  return {
    release: deps.release, mode: deps.mode.mode, top: sampled.slice(0, STATS_TOP),
    down: deps.runtimes.filter((r) => r.state === 'failed' || r.broken).map((r) => r.def.id),
    paused: deps.runtimes.filter((r) => r.paused).map((r) => r.def.id),
    memory, segPending: deps.segments.pending(),
  };
};
