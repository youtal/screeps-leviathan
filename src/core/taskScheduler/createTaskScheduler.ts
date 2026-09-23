/**
 * 文件摘要
 *
 * 模块角色：core/taskScheduler 的主实现，Runtime 组装的内核能力，为 CoreRuntime.tasks
 * 提供 TaskHost（详见 docs/design/core/taskScheduler.md）。
 *
 * 主要功能：接收生成器形式的任务体，按 owner 隔离命名空间，在 Framework 每 tick 调用一次
 * 的 drive 里协作式驱动就绪任务。每开始一片前用注入 CpuBudget 的 admit() 判断（普通插件的
 * 准入口径，任务主要使用本 tick 常规额度中插件没用完的部分），bucket 达到高水位时另可使用
 * 高于水位的盈余，并按每个任务的每 tick 软上限分配；提供优先级加轮转的调度、失败隔离、
 * deadline 过期、闲置回收、按 owner 释放、硬终止后有限次数的按 body 重启，以及经存储分区
 * 记录的跨 global 重启计数。
 *
 * 实现过程：registry 是唯一的状态容器（Map<owner+分隔符+id, TaskEntry>，身份字段在入口校验）。submit 只保证实例
 * 存在（任何状态都返回已有实例），release、releaseOwner 与闲置回收负责移除。drive 先 sweep
 * 一遍处理闲置回收、deadline 过期与硬终止恢复，再从活跃且 bucket 达标的任务建一个按
 * (priority desc, roundServed asc) 排序的 PriorityQueue，循环弹出、驱动一片；若仍活跃且未达
 * 每 tick 上限，就带着更新后的 roundServed 重新入队，直到队列空或 admit() 拒绝。每个实例的
 * TaskContext 与 TaskHandle 都只创建一次，字段是读取条目当前值的访问器。
 *
 * 技术要点：单个任务的异常（包括硬终止后重建任务体时 body 的异常）由注入的
 * ErrorMapper.capture 捕获并规范化为 PluginFailure，pluginId 为 owner、phase 为 'framework'，
 * 不影响其它任务或 drive 本身。分片耗时用 Game.cpu.getUsed 前后差值计量。每个任务的
 * Profiler 标签是 task.<owner>.<label>，在创建实例时拼好；owner 与 label 都要求来自固定
 * 有限的集合，避免 Profiler 与健康表因动态键无界增长。注册表等 heap 状态只存在于本工厂
 * 闭包，global reset 后随 Runtime 一起重建；唯一的持久化是经注入 MemoryHost 申请的一个
 * 分区（保留 owner framework 下的 tasks），只在 persist 中写入，不直接访问 Memory/RawMemory。
 */
import type {
  CpuBudget,
  ErrorMapper,
  LoggerFactory,
  MemoryAccessor,
  MemoryHost,
  PluginFailure,
  Profiler,
  TaskBody,
  TaskContext,
  TaskHandle,
  TaskHost,
  TaskOptions,
  TaskScheduler,
  TaskState,
} from '@/contracts';
import { PriorityQueue } from '@/utils/priorityQueue';

/**
 * 组合 owner 与 id 的注册表键。入口拒绝 NUL，保证分隔符不出现在字段内部，
 * 不同 (owner, id) 因而不会拼出相同的键。
 */
const SEPARATOR = '\u0000';
const registryKey = (owner: string, id: string): string => owner + SEPARATOR + id;

/**
 * 身份字段也充当 MemoryManager 的字符串路径段。与其路径保留键规则保持一致，
 * 并拒绝注册键分隔符；在创建实例/绑定 owner 前报错，避免运行中的任务没有重启记录。
 * owner 在 bind 校验一次，id 在 submit 校验；get/release 不会创建条目或写入记录。
 */
const validIdentityPart = (value: string): boolean =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes(SEPARATOR) &&
  value !== '__proto__' &&
  value !== 'prototype' &&
  value !== 'constructor';

/**
 * 同一实例因硬终止被重启的次数上限。
 *
 * drive 只在 admit() 通过、即已用 CPU 低于常规额度时才开始新的一片，因此 drive 中的硬终止
 * 意味着单个分片独自越过了 tickLimit——几乎总是分片内死循环或一次过大的原生调用，重来
 * 通常会再次失败。允许重启一次，给偶发情形一次机会；第二次被中断即以 failed 结束，避免
 * 一个失控任务每 tick 触发一次硬终止。
 */
const MAX_HARD_RESTARTS = 1;

/**
 * 同一任务的实例连续经历多少次 global reset 仍未结束，就在下一次创建时直接以 failed 结束。
 *
 * 官方服务器可能在 CPU 硬终止后重建 isolate，注册表与 midSlice 标记随之丢失，调用方每 tick
 * 重新提交又会触发同一个硬终止。drive 位于 MemoryHost.end 之后，分片期间无法写入存储，也就
 * 无法记录“哪个任务正在执行”；这里退而记录“实例存续期间经历了几次 reset”。每次 reset 都会让
 * 任务从 body 重新开始，连续 3 次 reset 仍未完成的任务要么在反复拖垮 global，要么根本跑不完，
 * 以 failed 暴露给调用方。失败时删除记录，之后的 reset 给它新的机会（修复代码并部署后自动恢复）。
 */
const MAX_GLOBAL_RESTARTS = 2;

/**
 * 跨 global 记录所在的分区：owner 用内核保留名 framework（Framework 拒绝以它为插件 id，
 * 普通模块名也不应使用），localId 为 tasks。结构为 owner → 任务 id → 已经历的 reset 次数。
 * 申请配置必须是固定引用：MemoryManager 按 initialize/migrate 的引用判断声明是否一致。
 */
const RECORD_OWNER = 'framework';
const RECORD_PARTITION = 'tasks';
type TaskRecords = Record<string, Record<string, number>>;
const RECORD_DECLARATION = { version: 1, initialize: (): TaskRecords => ({}) };

/**
 * bucket 盈余额度与 tickLimit 之间至少保留的距离（CPU）。盈余模式下每 tick 可能用到常规额度的
 * 两倍，对 limit 较高的账号会接近 tickLimit；保留这段距离，避免单个稍大的分片越过硬上限。
 */
const BURST_HEADROOM = 100;

/**
 * 单个任务实例在 heap 中的完整状态；只在本模块内部使用，不发布到 contracts。
 *
 * - body 只在实例活跃期间保留，供硬终止后重建生成器；进入终态即释放，尽快放掉其闭包
 *   持有的引用（结果或故障仍可读取）。generator 同理，在终态置为 undefined。
 * - liveTick/liveUsed 是 context 访问器实际读取的幕后变量，由 driveOnce 在每次 next()
 *   之前更新；usedThisTick/usedTickStamp 把 CPU 消耗归零到“本 tick”，同一 tick 内被多次
 *   弹出时持续累加，既供 TaskContext.used 使用，也是每 tick 软上限的判据。
 * - roundServed 是同优先级轮转用的次级排序键：数值越小越优先，每次被驱动后更新为全局
 *   递增的 nextRound，从而把刚被服务过的任务排到同优先级队伍的末尾。
 * - midSlice 探测硬终止：只在 next() 调用期间为 true，正常返回或抛出后立即复位；如果下一次
 *   drive 发现它仍为 true，说明上一次调用在 next() 执行到一半时被引擎硬终止打断（CPU
 *   硬终止不保证后续代码执行）。drive 每 tick 至多调用一次，所以布尔值已足以区分“上一次
 *   被打断”，无需记录 tick。restarts 记录本实例因此被重启的次数。
 * - lastTouched 是最近一次被 submit/get 触碰的 tick，闲置回收据此判断调用方是否还关心
 *   这个实例。
 * - record 表示该实例在调度器分区中的记录状态：'pending' 待下一次 persist 登记（写入失败
 *   仍保持 pending），'stored' 已写入（结束或释放时需要删除），'none' 不再需要登记。
 */
interface TaskEntry {
  owner: string;
  id: string;
  /** Profiler 标签 task.<owner>.<label>，创建时拼好，避免每一片都拼接字符串。 */
  profilerLabel: string;
  priority: number;
  deadlineTicks: number | undefined;
  minBucket: number;
  maxCpuPerTick: number;
  body: TaskBody<unknown> | undefined;
  generator: Generator<void, unknown, void> | undefined;
  state: TaskState;
  result: unknown;
  failure: PluginFailure | undefined;
  firstTick: number;
  lastTouched: number;
  usedThisTick: number;
  usedTickStamp: number | undefined;
  roundServed: number;
  midSlice: boolean;
  restarts: number;
  record: 'pending' | 'stored' | 'none';
  liveTick: number;
  liveUsed: number;
  context: TaskContext;
  handle: TaskHandle<unknown>;
}

/** 活跃（会被继续调度）的状态集合，多处判断复用，避免枚举值散落各处。 */
const isActive = (state: TaskState): boolean =>
  state === 'queued' || state === 'running';

/**
 * 就绪队列的比较器：优先级降序；同优先级按 roundServed 升序（最久未被驱动的排前面），
 * 使 pop → 驱动一片 → 重新 push 的循环等价于把刚服务过的任务放到本优先级队尾。
 * 定义在模块级，每次 drive 不再分配新的闭包。
 */
const compareEntries = (pre: TaskEntry, nxt: TaskEntry): boolean =>
  pre.priority !== nxt.priority
    ? pre.priority > nxt.priority
    : pre.roundServed < nxt.roundServed;

export interface TaskSchedulerOptions {
  /** 延迟取值：每次调用都读取当 tick 的 Game，不跨 tick 缓存。 */
  getGame: () => Game;
  logging: LoggerFactory;
  errorMapper: ErrorMapper;
  /** 为 null 时任务分片计时直接跳过包装，不影响调度本身。 */
  profiler: Profiler | null;
  /**
   * 单个任务在未显式声明 TaskOptions.minBucket 时使用的缺省 bucket 门限，缺省 5000。
   * 与 Framework 的 minBucket 分别配置、没有联动；drive 同时要求 CpuBudget.admit() 通过，
   * 实际门限是两者中较高的一个。在 Framework 使用默认配置（1000）时，任务会在 bucket 回到
   * 5000 以下后暂停，让 bucket 以全部空闲额度回升。
   */
  defaultMinBucket?: number;
  /**
   * 单个任务在未显式声明 TaskOptions.maxCpuPerTick 时使用的每 tick CPU 软上限。缺省
   * Infinity（不限）：总量已经由 admit() 限制在本 tick 空闲的常规额度内，默认不再对单个
   * 任务设限，以免只有一个任务时白白让出空闲 CPU。
   */
  defaultMaxCpuPerTick?: number;
  /**
   * 实例连续多少个 tick 没有被 submit/get 触碰即被回收（活跃的先取消），缺省 1000；
   * Infinity 表示永不按闲置回收。用于回收调用方不再关心的实例：没人读取的结果、以及
   * 不经 Framework 生命周期管理的普通模块留下的任务。上一 global 留下、本 global 在这段
   * 时间内无人认领的跨 global 记录也按同一期限清理。
   */
  retainTicks?: number;
  /**
   * bucket 达到该值时，任务除常规额度的剩余外，还可以使用高于该水位的盈余：每 tick 至多再用
   * 一份常规额度（Game.cpu.limit），并与 tickLimit 保持 BURST_HEADROOM 的距离。缺省 9500；
   * Infinity 表示关闭。有积压任务时 bucket 因此维持在该水位附近，不再回满。
   */
  burstBucket?: number;
  /**
   * Runtime 注入的存储宿主，用于记录任务实例经历的 global reset 次数（见 MAX_GLOBAL_RESTARTS）。
   * 省略时不做跨 global 记录，其余功能不受影响；独立测试可以不提供。
   */
  memory?: MemoryHost;
}

/**
 * 创建一个 TaskHost 实例；每个 Runtime 只应创建一份，由 createRuntime 组装并通过
 * CoreRuntime.tasks 发布。工厂本身只校验参数、初始化空注册表，不做任何调度或 I/O。
 */
export const createTaskScheduler = (
  options: TaskSchedulerOptions
): TaskHost => {
  const { getGame, errorMapper } = options;
  const profiler = options.profiler;
  const defaultMinBucket = options.defaultMinBucket ?? 5000;
  if (!Number.isFinite(defaultMinBucket) || defaultMinBucket < 0) {
    throw new Error('Invalid default min bucket');
  }
  // `!(x > 0)` 同时拒绝 NaN、0 与负数，并允许 Infinity 表示“不限”。
  const defaultMaxCpuPerTick = options.defaultMaxCpuPerTick ?? Infinity;
  if (!(defaultMaxCpuPerTick > 0)) {
    throw new Error('Invalid default max CPU per tick');
  }
  const retainTicks = options.retainTicks ?? 1000;
  if (!(retainTicks > 0)) throw new Error('Invalid retain ticks');
  // `>= 0` 同样拒绝 NaN，并允许 Infinity 表示关闭盈余额度。
  const burstBucket = options.burstBucket ?? 9500;
  if (!(burstBucket >= 0)) throw new Error('Invalid burst bucket');
  const memoryHost = options.memory;
  const log = options.logging.scope('TaskScheduler');
  /**
   * 唯一状态容器：在工厂闭包内创建，只有 submit 新建条目；release、releaseOwner 与 sweep
   * 中的闲置回收删除条目。跨 tick 有效，global reset 后随闭包一起被丢弃，不做任何持久化。
   */
  const registry = new Map<string, TaskEntry>();
  /** 同优先级轮转的全局计数器，只增不减；具体数值没有业务含义，只用于比较先后。 */
  let nextRound = 0;
  /**
   * 跨 global 记录的 heap 侧状态（只在 persist 中读写分区，见 MAX_GLOBAL_RESTARTS）：
   * - records：本 global 首次 persist 时申请的分区访问器，之后长期复用；申请失败则保持
   *   undefined，下一次 persist 重试。
   * - inherited：首次申请时分区里已有的记录，即上一 global 结束时仍存续的实例；键为注册表键。
   *   同键实例在本 global 首次登记时取出并加一，取出后删除；本 global 写入的记录不进入它，
   *   因此不会被误算成 reset。无人认领的旧记录在 retainTicks 后清理。
   * - pendingRegistrations：创建后尚未登记的实例；pendingRemovals：已结束或已释放、记录待删除
   *   的实例。drive 期间（MemoryHost.end 之后）不能写入分区，两者都攒到下一次 persist。
   * - lastPersistError：最近一次记录过的存储故障文本，同一故障只告警一次。
   * 全部驻留 heap，global reset 后重建，重建后的首次 persist 从分区恢复 inherited。
   */
  let records: MemoryAccessor<TaskRecords> | undefined;
  let inherited:
    | Map<string, { owner: string; id: string; resets: number }>
    | undefined;
  let inheritedSince = 0;
  let pendingRegistrations: TaskEntry[] = [];
  const pendingRemovals = new Map<string, TaskEntry>();
  let lastPersistError: string | undefined;
  /**
   * 每个 Profiler 标签只 wrap 一次并跨 tick 复用，与 Framework 自身的 measure
   * helper 是同一种模式，但各自独立缓存——两者包装的是不同标签空间，没有共享的
   * 必要，合并成公共工具反而会让不相关模块通过一个中间层耦合。表的大小受
   * “owner 与 label 来自固定集合”的约束限制，因此不做淘汰。
   */
  const wrappers = new Map<string, (fn: () => any) => any>();
  const measureTask = <T>(label: string, callback: () => T): T => {
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

  /**
   * 进入终态的唯一出口：释放生成器与 body（只有活跃实例需要它们），清除运行标记。
   * 结果与故障由调用方在此之前写入条目。
   */
  const finish = (
    entry: TaskEntry,
    state: Exclude<TaskState, 'queued' | 'running'>
  ): void => {
    entry.state = state;
    entry.generator = undefined;
    entry.body = undefined;
    entry.midSlice = false;
    // 已登记的实例结束（任何终态）即不再需要跨 global 记录，删除留给下一次 persist。
    if (entry.record === 'stored') {
      pendingRemovals.set(registryKey(entry.owner, entry.id), entry);
      entry.record = 'none';
    }
  };

  /** 从注册表移除一个实例；活跃的先转为 cancelled，已发出的句柄因此停在 cancelled。 */
  const remove = (key: string, entry: TaskEntry): void => {
    if (isActive(entry.state)) finish(entry, 'cancelled');
    registry.delete(key);
  };

  /** 为一个任务实例构造只创建一次的 TaskContext；字段是读取条目幕后变量的访问器。 */
  const createContext = (entry: TaskEntry): TaskContext => ({
    get tick() {
      return entry.liveTick;
    },
    get used() {
      return entry.liveUsed;
    },
  });

  /**
   * 为一个任务实例构造只创建一次的实时句柄；state/result/failure 每次读取都反映条目当前
   * 状态，submit/get 反复返回同一对象，轮询不产生新的分配。
   */
  const createHandle = (entry: TaskEntry): TaskHandle<unknown> => ({
    id: entry.id,
    get state() {
      return entry.state;
    },
    get result() {
      return entry.state === 'done' ? entry.result : undefined;
    },
    get failure() {
      return entry.state === 'failed' ? entry.failure : undefined;
    },
    cancel: () => {
      if (isActive(entry.state)) finish(entry, 'cancelled');
    },
  });

  /** 校验配置并从 body 创建一份全新的任务实例；body 抛错直接传给调用方，注册表不变。 */
  const createEntry = (
    owner: string,
    id: string,
    body: TaskBody<unknown>,
    options: TaskOptions,
    tick: number
  ): TaskEntry => {
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new Error('Invalid task priority');
    if (
      options.deadlineTicks !== undefined &&
      (!Number.isFinite(options.deadlineTicks) || options.deadlineTicks <= 0)
    ) {
      throw new Error('Invalid task deadline');
    }
    if (
      options.minBucket !== undefined &&
      (!Number.isFinite(options.minBucket) || options.minBucket < 0)
    ) {
      throw new Error('Invalid task min bucket');
    }
    const maxCpuPerTick = options.maxCpuPerTick ?? defaultMaxCpuPerTick;
    if (!(maxCpuPerTick > 0)) throw new Error('Invalid task max CPU per tick');
    const entry: TaskEntry = {
      owner,
      id,
      profilerLabel: 'task.' + owner + '.' + (options.label ?? id),
      priority,
      deadlineTicks: options.deadlineTicks,
      minBucket: options.minBucket ?? defaultMinBucket,
      maxCpuPerTick,
      body,
      generator: undefined,
      state: 'queued',
      result: undefined,
      failure: undefined,
      firstTick: tick,
      lastTouched: tick,
      usedThisTick: 0,
      usedTickStamp: undefined,
      // -1 使全新任务的排序键低于任何已经被驱动过至少一次的同优先级任务（roundServed
      // 从 0 起算），令它在下一轮调度中优先获得第一次机会，而不是排在末尾陪跑。
      roundServed: -1,
      midSlice: false,
      restarts: 0,
      record: memoryHost ? 'pending' : 'none',
      liveTick: tick,
      liveUsed: 0,
      // 占位后立即替换：两个访问器对象都需要捕获已经存在的 entry 引用。
      context: undefined as unknown as TaskContext,
      handle: undefined as unknown as TaskHandle<unknown>,
    };
    entry.context = createContext(entry);
    entry.handle = createHandle(entry);
    entry.generator = body(entry.context);
    return entry;
  };

  /** submit：已有实例（任何状态）直接返回并刷新闲置计时；只有不存在时才创建。 */
  const submitFor = <T>(
    owner: string,
    id: string,
    body: TaskBody<T>,
    options: TaskOptions = {}
  ): TaskHandle<T> => {
    if (!validIdentityPart(id)) throw new Error('Invalid task id');
    const tick = getGame().time;
    const key = registryKey(owner, id);
    const existing = registry.get(key);
    if (existing) {
      existing.lastTouched = tick;
      return existing.handle as TaskHandle<T>;
    }
    const entry = createEntry(owner, id, body as TaskBody<unknown>, options, tick);
    registry.set(key, entry);
    if (entry.record === 'pending') pendingRegistrations.push(entry);
    return entry.handle as TaskHandle<T>;
  };

  const getFor = <T>(owner: string, id: string): TaskHandle<T> | undefined => {
    const entry = registry.get(registryKey(owner, id));
    if (!entry) return undefined;
    entry.lastTouched = getGame().time;
    return entry.handle as TaskHandle<T>;
  };

  const releaseFor = (owner: string, id: string): void => {
    const key = registryKey(owner, id);
    const entry = registry.get(key);
    if (entry) remove(key, entry);
  };

  /**
   * 对单个任务驱动一片；不抛出——生成器异常经 ErrorMapper 捕获并转为 failed。
   * 分片耗时用 Game.cpu.getUsed 的前后差值计量：它直接反映真实消耗，不像
   * CpuBudget.remaining() 那样在耗尽后截断为 0 而少算最后一片。
   */
  const driveOnce = (entry: TaskEntry, tick: number): void => {
    // 同一个任务在同一 tick 内可能被多次弹出，usedThisTick 在这些次数间累加；换到下一个
    // tick 的首次驱动时清零，用 usedTickStamp 判断是否已跨 tick。
    if (entry.usedTickStamp !== tick) {
      entry.usedThisTick = 0;
      entry.usedTickStamp = tick;
    }
    entry.state = 'running';
    entry.liveTick = tick;
    entry.liveUsed = entry.usedThisTick;
    entry.roundServed = nextRound++;
    // 活跃实例一定持有生成器（只有 finish 会清空它，而 finish 同时把状态改为终态）；
    // 先取到局部变量，next() 执行期间任务取消自己也不影响本次调用。
    const generator = entry.generator!;
    const cpu = getGame().cpu;
    const before = cpu.getUsed();
    // 硬终止探测标记：只在 next() 执行期间为 true。若引擎在这里把本 tick 杀死，
    // 标记会原样保留到下一次 drive，被 sweep 发现。
    entry.midSlice = true;
    const captured = errorMapper.capture(
      { tick, pluginId: entry.owner, phase: 'framework' },
      () => measureTask(entry.profilerLabel, () => generator.next())
    );
    entry.midSlice = false;
    entry.usedThisTick += cpu.getUsed() - before;
    // 分片中被 cancel 或 release（例如任务取消了自己）：保留取消结果，不再覆盖。
    if (!isActive(entry.state)) return;
    if (!captured.ok) {
      entry.failure = captured.failure;
      finish(entry, 'failed');
      return;
    }
    if (captured.value.done) {
      entry.result = captured.value.value;
      finish(entry, 'done');
    }
    // 否则生成器只是 yield，state 保持 'running'，留给外层决定是否重新入队。
  };

  /**
   * 硬终止恢复：上一次 drive 在本任务的 next() 中途被打断。重启次数未超过上限时，在错误
   * 边界内调用 body 重建生成器（body 可能读取已经失效的游戏状态而抛错，异常只让本任务
   * 失败，不能逃出 sweep 拖垮全部任务）；超过上限则以 failed 结束。
   */
  const recover = (entry: TaskEntry, tick: number): void => {
    entry.midSlice = false;
    entry.restarts++;
    const metadata = { tick, pluginId: entry.owner, phase: 'framework' as const };
    if (entry.restarts > MAX_HARD_RESTARTS) {
      // 借 capture 规范化一条合成故障：与普通任务失败走同一报告出口与堆栈格式。
      const interrupted = errorMapper.capture(metadata, () => {
        throw new Error(
          'Task ' +
            entry.id +
            ' interrupted by the hard CPU limit ' +
            entry.restarts +
            ' times'
        );
      });
      entry.failure = interrupted.ok ? undefined : interrupted.failure;
      finish(entry, 'failed');
      return;
    }
    log.warn(
      () =>
        `task ${entry.owner}/${entry.id} interrupted mid-slice by hard CPU limit; restarting from body`
    );
    // 活跃实例一定保留着 body（只有 finish 会释放它）。
    const body = entry.body!;
    const created = errorMapper.capture(metadata, () => body(entry.context));
    if (!created.ok) {
      entry.failure = created.failure;
      finish(entry, 'failed');
      return;
    }
    entry.generator = created.value;
    entry.state = 'queued';
    entry.usedThisTick = 0;
    entry.usedTickStamp = undefined;
    // firstTick 刻意不重置：硬终止恢复不是一次新的提交，deadline 仍从实例创建时起算。
  };

  /**
   * drive 前的清扫，每个条目按顺序判断：
   * 1. 闲置回收：任何状态的实例连续 retainTicks 个 tick 未被触碰即移除（活跃的先取消）；
   * 2. deadline 过期：先于硬终止恢复判断，反复被硬终止的任务也会按期过期；
   * 3. 硬终止恢复：见 recover。
   * 所有可能执行任务代码的步骤都在错误边界内，单个条目的异常不会中断遍历。
   * Map 允许在 for...of 遍历中删除当前条目。
   */
  const sweep = (tick: number): void => {
    for (const [key, entry] of registry) {
      if (tick - entry.lastTouched >= retainTicks) {
        log.info(
          () => `task ${entry.owner}/${entry.id} released after ${retainTicks} idle ticks`
        );
        remove(key, entry);
        continue;
      }
      if (!isActive(entry.state)) continue;
      if (
        entry.deadlineTicks !== undefined &&
        tick - entry.firstTick >= entry.deadlineTicks
      ) {
        finish(entry, 'expired');
        log.warn(() => `task ${entry.owner}/${entry.id} expired after deadline`);
        continue;
      }
      if (entry.midSlice) recover(entry, tick);
    }
  };

  /** 存储故障只告警一次：同一文本重复出现时静默，直到出现新的故障文本。 */
  const reportPersistError = (error: unknown): void => {
    let message = 'unprintable error';
    try {
      message = String(error);
    } catch {
      /* 损坏的 toString 不能击穿 persist。 */
    }
    if (message === lastPersistError) return;
    lastPersistError = message;
    log.warn(() => 'task records not persisted: ' + message);
  };

  /** 在错误边界内执行一次分区写入；失败只告警并返回 false，不影响其余记录。 */
  const tryWrite = (write: () => void): boolean => {
    try {
      write();
      return true;
    } catch (error) {
      reportPersistError(error);
      return false;
    }
  };

  /**
   * 写入 owner/id 的记录。只用路径写入，MemoryManager 在修改前预检路径与值；
   * 身份字段已在入口校验，避免路径失败造成任务无记录。owner 条目缺失时先提交
   * 完整对象，路径写入不会自动创建中间容器。
   */
  const writeRecord = (
    accessor: MemoryAccessor<TaskRecords>,
    owner: string,
    id: string,
    resets: number
  ): void => {
    if (accessor.get([owner]) === undefined) accessor.commit([owner], { [id]: resets });
    else accessor.commit([owner, id], resets);
  };

  /** 删除 owner/id 的记录；owner 下没有其他记录时一并删除 owner 条目，分区不留空壳。 */
  const removeRecord = (
    accessor: MemoryAccessor<TaskRecords>,
    owner: string,
    id: string
  ): void => {
    const bucket = accessor.get([owner]);
    if (bucket === undefined) return;
    if (id in bucket) accessor.remove([owner, id]);
    // 若上次已删 id、随后删除空 owner 失败，重试仍须把空 owner 清理掉。
    if (Object.keys(accessor.get([owner]) ?? {}).length === 0) accessor.remove([owner]);
  };

  /**
   * 首次申请分区时读取已有记录作为 inherited。数值不合规的记录（非非负整数）视为不存在，
   * 登记时会被覆盖；读取只遍历分区一次，之后不再全量扫描。
   */
  const loadInherited = (accessor: MemoryAccessor<TaskRecords>, tick: number): void => {
    const data = accessor.query();
    const loaded = new Map<string, { owner: string; id: string; resets: number }>();
    for (const owner of Object.keys(data)) {
      const bucket = data[owner];
      for (const id of Object.keys(bucket)) {
        const resets = bucket[id];
        if (Number.isInteger(resets) && resets >= 0)
          loaded.set(registryKey(owner, id), { owner, id, resets });
      }
    }
    // 查询或枚举失败时不发布半成品，下次 persist 才能重试完整装载。
    inherited = loaded;
    inheritedSince = tick;
  };

  /**
   * 在 MemoryHost 的写入阶段把待处理的记录落到分区：先删除已结束实例的记录，再登记新实例，
   * 最后清理超过 retainTicks 仍无人认领的旧记录。没有待处理事项时不申请分区、不标脏，空闲
   * tick 只有几次长度判断。申请或路径操作失败只告警，待处理事项保留到下一次 persist。
   *
   * 登记规则：同键在上一 global 结束时仍有存续实例（inherited 中有记录），本实例的 reset 次数
   * 即为旧值加一；超过 MAX_GLOBAL_RESTARTS 时本实例直接以 failed 结束（此时它尚未被驱动过，
   * persist 位于 drive 之前）并删除记录，否则写入新次数。
   */
  const persist = (tick: number): void => {
    if (!memoryHost) return;
    const purgeDue =
      inherited !== undefined &&
      inherited.size > 0 &&
      tick - inheritedSince >= retainTicks;
    if (pendingRegistrations.length === 0 && pendingRemovals.size === 0 && !purgeDue)
      return;
    let accessor = records;
    if (!accessor) {
      try {
        accessor = memoryHost.bind(RECORD_OWNER)(
          RECORD_PARTITION,
          RECORD_DECLARATION
        ) as MemoryAccessor<TaskRecords>;
      } catch (error) {
        reportPersistError(error);
        return;
      }
      records = accessor;
    }
    const target = accessor;
    if (!inherited) {
      try {
        loadInherited(target, tick);
      } catch (error) {
        reportPersistError(error);
        return;
      }
    }
    const known = inherited!;
    for (const [key, entry] of pendingRemovals)
      if (tryWrite(() => removeRecord(target, entry.owner, entry.id)))
        pendingRemovals.delete(key);
    const registrations = pendingRegistrations;
    pendingRegistrations = [];
    for (const entry of registrations) {
      if (entry.record !== 'pending') continue;
      const key = registryKey(entry.owner, entry.id);
      // 登记前已经结束（例如被取消）或被释放的实例不需要记录；同键旧记录（若有）保留，
      // 由之后同键实例的登记或 retainTicks 后的清理处理。
      if (!isActive(entry.state) || registry.get(key) !== entry) {
        entry.record = 'none';
        continue;
      }
      // 同键旧记录尚未删掉时先重试删除，防止后续重试误删新登记的实例。
      if (pendingRemovals.has(key)) {
        pendingRegistrations.push(entry);
        continue;
      }
      const previous = known.get(key);
      const resets = previous === undefined ? 0 : previous.resets + 1;
      if (resets > MAX_GLOBAL_RESTARTS) {
        // 借 capture 规范化一条合成故障：与普通任务失败走同一报告出口与堆栈格式。
        const blocked = errorMapper.capture(
          { tick, pluginId: entry.owner, phase: 'framework' },
          () => {
            throw new Error(
              'Task ' +
                entry.id +
                ' restarted by ' +
                resets +
                ' global resets without completing'
            );
          }
        );
        entry.failure = blocked.ok ? undefined : blocked.failure;
        finish(entry, 'failed');
        entry.record = 'none';
        known.delete(key);
        if (!tryWrite(() => removeRecord(target, entry.owner, entry.id)))
          pendingRemovals.set(key, entry);
        continue;
      }
      if (tryWrite(() => writeRecord(target, entry.owner, entry.id, resets))) {
        entry.record = 'stored';
        known.delete(key);
      } else pendingRegistrations.push(entry);
    }
    if (purgeDue) {
      for (const [key, { owner, id }] of known) {
        // 登记暂时失败的活跃实例仍认领这条旧记录，不能把它按孤儿清理。
        const entry = registry.get(key);
        if (entry?.record === 'pending' && isActive(entry.state)) continue;
        if (tryWrite(() => removeRecord(target, owner, id))) known.delete(key);
      }
    }
  };

  const drive = (tick: number, cpu: CpuBudget): void => {
    sweep(tick);
    const gameCpu = getGame().cpu;
    const bucket = gameCpu.bucket ?? Infinity;
    const ready: TaskEntry[] = [];
    for (const entry of registry.values()) {
      if (isActive(entry.state) && bucket >= entry.minBucket) ready.push(entry);
    }
    // 空闲 tick 不分配队列：没有就绪任务时 drive 只剩一次清扫。
    if (ready.length === 0) return;
    const queue = new PriorityQueue<TaskEntry>(ready, compareEntries);
    /**
     * 盈余额度：bucket 达到 burstBucket 时，已用 CPU 可以超过常规口径，直到 limit 加上
     * “高于水位的盈余与一份常规额度中的较小者”，且与 tickLimit（扣除 reserveCpu）保持
     * BURST_HEADROOM 的距离。只花高于水位的部分，本 tick 结束后 bucket 仍不低于水位；
     * bucket 未知（模拟环境）或 limit 缺失时计算结果为 NaN/undefined，比较恒为假，等于关闭。
     */
    const burstCeiling =
      gameCpu.bucket !== undefined && gameCpu.bucket >= burstBucket
        ? gameCpu.limit + Math.min(gameCpu.bucket - burstBucket, gameCpu.limit)
        : undefined;
    // admit() 是普通插件的准入口径（bucket 达到 Framework 的 minBucket，且已用 CPU 低于
    // limit 减 reserveCpu）：任务主要使用本 tick 常规额度的剩余，分片估算偏差多出的部分由
    // bucket 承担，而不会把本 tick 推向 tickLimit。
    const canStart = (): boolean =>
      cpu.admit() ||
      (burstCeiling !== undefined &&
        getGame().cpu.getUsed() < burstCeiling &&
        cpu.remaining() > BURST_HEADROOM);
    while (!queue.isEmpty && canStart()) {
      const entry = queue.pop()!;
      // 队列在 drive 开始时建好；同一轮中被其他任务或事件回调取消、释放的条目仍在队列里，
      // 必须跳过，否则会被重新置为 running 并因生成器已释放而失败。
      if (!isActive(entry.state)) continue;
      driveOnce(entry, tick);
      // 达到每 tick 软上限的任务本 tick 不再入队，让出的 CPU 留给其他任务。
      if (isActive(entry.state) && entry.usedThisTick < entry.maxCpuPerTick) {
        queue.push(entry);
      }
    }
  };

  return {
    bind: (owner: string): TaskScheduler => {
      if (!validIdentityPart(owner)) throw new Error('Invalid task owner');
      return {
        submit: (id, body, taskOptions) =>
          submitFor(owner, id, body, taskOptions),
        get: (id) => getFor(owner, id),
        release: (id) => releaseFor(owner, id),
      };
    },
    drive,
    persist,
    releaseOwner: (owner: string) => {
      for (const [key, entry] of registry) {
        if (entry.owner === owner) remove(key, entry);
      }
    },
    getStatus: () => {
      let queued = 0;
      let running = 0;
      for (const entry of registry.values()) {
        if (entry.state === 'queued') queued++;
        else if (entry.state === 'running') running++;
      }
      return { queued, running };
    },
  };
};
