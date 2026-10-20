/**
 * 文件摘要：kernel.memory 的实例根状态、平台接管与持久结构加载，设计见 docs/design/kernel/memory.md。
 * 宿主显式传入平台端口及 tick 事实；构造不访问游戏对象，beginTick 在首次读取 Memory 前安装临时值。
 * 每个实例只解析一次，索引和脏集合跨 tick 持有；dispose/global reset 后不可复用旧能力。
 * 待确认文本用于发现驱动收尾丢弃写入，下一 tick 只比较文本、不再次解析；不访问私有 _parsed。
 * 损坏文本、同名命名空间结构不符或 schema 不匹配时拒绝写入；命名空间缺失时其他根键只读保留，
 * 初始化仅在宿主显式授权后加入命名空间。清空同样只在宿主授权后执行（boot 特权端口，docs/design/kernel/bootPort.md），
 * Memory 不做 boot 判定。加载时缓存原始文本与概要，供 boot 备份与判定读取本实例加载时的原貌。
 */
import type { ProjectMarker, RawMemorySummary } from '@/contracts/boot';
import type { Json } from '@/contracts/memory';
import { checkKey, copyJson, isObject, validateJson } from './json';
import { checkMarker, summarize, UNPARSED_SUMMARY } from './marker';
import type { Space, Unit, UnitRecord } from './unit';

/** 平台适配由宿主注入；read/write 必须转发当前 tick 的 RawMemory，不能捕获旧平台对象。 */
export interface MemoryPlatformPort {
  /** 安装 Memory 访问器的对象；游戏中为 globalThis，测试中为隔离对象。 */
  readonly target: object;
  /**
   * @description 读取当前 tick 的原始文本，不触发全局 Memory 惰性解析。
   * @returns 原始 Memory 字符串。
   * @throws {*} 平台读取失败时由宿主实现抛出。
   */
  read(): string;
  /**
   * @description 同步提交候选文本；驱动收尾仍可能拒绝整个 tick。
   * @param text 已校验、编码并检查长度的完整根文本。
   * @returns 无返回值；正常结束仅表示写入口成功。
   * @throws {*} 平台写入失败时由宿主实现抛出。
   */
  write(text: string): void;
  /**
   * @description 接收容量告警，由宿主提供输出方式；模块隔离此回调异常。
   * @param message 不含业务数据的告警正文。
   * @returns 无返回值。
   */
  warn(message: string): void;
}
/** 宿主采集的本 tick 事实；Memory 只据此维护记录，不直接读取 Game 或推断殖民地业务。 */
export interface TickFacts {
  /** 相邻 time 才能作为 creep 连续缺席的证据；允许同 tick 重入，拒绝时间倒退。 */
  readonly time: number;
  /** 包含孵化中 creep 的当前名称集合；beginTick 复制集合，隔离调用方后续修改。 */
  readonly creeps: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
  /** 缺失条目必须保留房间；此表不深拷贝，宿主须保持本 tick 内的只读快照。 */
  readonly rooms?: Readonly<Record<string, { readonly owned: boolean; readonly protected: boolean; readonly lastSeen: number }>>;
}
/** 身份与根 schema 由装配指定；schema 不同一律拒绝，不在此处猜测升级或接管策略。 */
export interface MemoryOptions {
  readonly namespace: string;
  readonly signature: string;
  readonly schema: number;
  readonly platform: MemoryPlatformPort;
  /** 开发期每次 commit 抽查的未标脏单元数；0 关闭。 */
  readonly auditUnits?: number;
}
/** part 的两级键是 owner/localId；实体空间的两级键是实体名/owner。sys 不使用单元包络。 */
export type Namespace = { sys: ProjectMarker } & Record<Space, Record<string, Record<string, UnitRecord>>>;
/** 维护索引引用根对象中的同一张切片表；删除实体时必须同时移除索引和根记录。 */
export interface EntityRecord {
  readonly space: Exclude<Space, 'part'>;
  readonly key: string;
  readonly slices: Record<string, UnitRecord>;
  /**
   * 整条记录在本实例中的创建 tick，只存于 heap，不进入持久文本。新增其他 owner 的切片不刷新它；
   * 记录删除后同名重建得到新值。加载得到的记录为负无穷：它们早于本 global，不需要新建保护。
   * 回收据此跳过本 tick 新建的记录，因为 beginTick 的名称快照看不到快照之后才创建的 creep/flag。
   */
  readonly createdAt: number;
}
/** 最近成功调用 write 的字符数快照；初始为零，驱动是否接受由下一 tick 再确认。 */
export interface SizeSnapshot {
  /** 完整根文本长度，包含其他根字段及所有键、分隔符。 */
  readonly total: number;
  /** 各空间完整对象文本的长度；sys 为项目标记文本长度。 */
  readonly spaces: Readonly<Record<Space | 'sys', number>>;
  /** owner 所有单元包络的长度之和，不含空间及单元索引键。 */
  readonly owners: Readonly<Record<string, number>>;
}
/** 实例共享状态，仅 kernel.memory 内部持有；所有能力通过 check 复用生命周期闸门。 */
export interface Runtime {
  readonly options: MemoryOptions;
  /** { [JSON 编码的 space,parent,key 三元组]: 对应存储单元 }，编码消除分隔符歧义。 */
  readonly units: Map<string, Unit>;
  /** { [JSON 编码的 space,key 二元组]: 实体记录及切片表 }，维护游标直接遍历此表。 */
  readonly records: Map<string, EntityRecord>;
  /** 待编码的单元对象集合；重复写同一单元不会重复排队，成功提交或回收时移除。 */
  readonly dirty: Set<Unit>;
  /** dispose 置 false；旧能力即使仍被业务持有，也不能再访问存储。 */
  active: boolean;
  /** 首次加载开始即置 true；加载失败不允许在后续 tick 自动重试或误当空存储。 */
  loaded: boolean;
  /** 加载错误锁存，后续访问继续抛出；提交错误不锁存，以便保留 heap 数据重试。 */
  failure?: unknown;
  /** 完整根对象；data 是其中本项目命名空间的同一引用，其他根字段只保留不修改。 */
  root: Record<string, Json>;
  data?: Namespace;
  facts?: TickFacts;
  /** 仅相邻 tick 保存上一份名称快照；reset 或跳 tick 时为空，禁止据此回收 creep。 */
  previousCreeps?: ReadonlySet<string>;
  /** 单元增删、首次加载或持久化未确认时强制拼根串；即使 dirty 为空也必须提交。 */
  structural: boolean;
  /** 最近一次写入尝试的完整文本，在下一 tick 原始文本与之相等后释放。 */
  pending?: string;
  /** 本 tick 已成功调用 write；防止同 tick 再次提交，新 tick 清零。 */
  written: boolean;
  /** 告警/写入口回调期间的重入保护，finally 或下一 tick 清零。 */
  committing: boolean;
  sizes: SizeSnapshot;
  /**
   * 本实例加载时读到的原始文本，保留到实例销毁，供 boot 备份；平台读取失败时为 undefined。
   * 最多约 2 Mi 字符的 heap 占用，换取备份反映迁移或清空之前的原貌（bootPort 设计第 3 节）。
   */
  text?: string;
  /** 加载时计算的深冻结概要；尚未加载时为 undefined，读取或解析失败时为 UNPARSED_SUMMARY。 */
  summary?: RawMemorySummary;
  /**
   * 项目标记最近一次已知合法的编码：加载、初始化、清空时建立，sys 写入后经提交校验通过才更新。
   * 提交发现 sys 非法时沿用此编码写出（单元级隔离），所以必须在任何 sys 写入之前建立。
   */
  sysText?: string;
  /**
   * sysText 所代表标记的 epoch，与 sysText 在同一处建立和更新，供 segments 写页头与校验页（kernel.lifecycle 注入）。
   * 不读 heap 中的 sys：boot 写入的非法值被隔离、或提交失败时，heap 值不是已持久化的 epoch（第二轮审计 SR-03）。
   */
  sysEpoch?: number;
  /** sys 访问器背后的运行时单元，首次取得访问器时创建；不在 units 索引中，提交单独处理。 */
  sysUnit?: Unit;
  /**
   * @description 检查实例是否允许访问存储。
   * @returns 无返回值；正常结束表示已加载且可访问。
   * @throws {Error} 实例已销毁、正在提交、加载失败或尚未初始化。
   */
  check(): void;
  /**
   * @description 在根表已经维护后登记单元索引，调用方保证身份尚未登记。
   * @param space 存储空间。
   * @param parent 分区 owner 或实体名称。
   * @param key 分区 localId 或实体切片 owner。
   * @param record 根表中同一引用的合法单元包络。
   * @param dirty 是否标为新增脏单元，默认 false。
   * @returns 新建的运行时单元；dirty 为 true 时同时标记结构变化。
   */
  register(space: Space, parent: string, key: string, record: UnitRecord, dirty?: boolean): Unit;
}

/**
 * @description 生成 heap 单元索引键，JSON 元组编码避免名称含分隔符时身份碰撞。
 * @param space 存储空间。
 * @param parent 分区 owner 或实体名称。
 * @param key 分区 localId 或实体切片 owner。
 * @returns space、parent、key 三元组的 JSON 文本。
 */
export const unitId = (space: Space, parent: string, key: string): string => JSON.stringify([space, parent, key]);
/**
 * @description 生成维护扫描使用的记录身份，不包含切片 owner。
 * @param space 记录所在空间。
 * @param key 实体名称。
 * @returns space、key 二元组的 JSON 文本。
 */
export const recordId = (space: Space, key: string): string => JSON.stringify([space, key]);

/**
 * @description 首次读取时由解析结果建立索引，成本与原始数据规模成正比。
 * 所有已有单元（包括未声明的 owner）都登记，避免首次拼串时丢弃未知业务数据。
 * 中途失败可能已创建部分索引，但 beginTick 会锁存异常，禁止发布能力或提交半份数据。
 * 本项目命名空间缺失时只保留根对象，等待宿主授权初始化：空根、引擎默认空对象形状（11.3 的 EMPTY）
 * 与外来根键（11.4 b′ 等只读保留情形）都走这条路径；是否允许初始化由 boot 判定，Memory 不推断。
 * 命名空间存在但结构、身份或 schema 不符时仍拒绝，不覆盖已占用的同名命名空间。
 * @param state 待装载的实例状态。
 * @param root 原始文本的解析结果，空白文本由调用方按空对象传入。
 * @returns 无返回值；成功时安装根数据及单元索引，命名空间缺失时等待显式初始化。
 * @throws {Error} 根不是对象，或本项目命名空间的结构、身份、schema 或单元包络非法。
 */
const load = (state: Runtime, root: unknown): void => {
  validateJson(root);
  if (!isObject(root)) throw new Error('Memory 根结构非法');
  if (!Object.hasOwn(root, state.options.namespace)) { state.root = root as Record<string, Json>; return; }
  const data = root[state.options.namespace];
  // 命名空间与包络使用精确字段集合：未知结构须显式处理，不能在重拼时静默丢字段。
  if (!isObject(data) || Object.keys(data).sort().join(',') !== 'creeps,flags,part,rooms,sys'
    || !checkMarker(data.sys, state.options)) throw new Error('Memory 身份或 schema 不匹配');
  for (const space of ['part', 'rooms', 'creeps', 'flags'] as const) {
    const groups = data[space];
    if (!isObject(groups)) throw new Error('Memory 空间结构非法');
    for (const parent of Object.keys(groups)) {
      checkKey(parent);
      const table = groups[parent];
      if (!isObject(table)) throw new Error('Memory 单元表非法');
      for (const key of Object.keys(table)) {
        checkKey(key);
        const record = table[key];
        if (!isObject(record) || Object.keys(record).sort().join(',') !== 'data,version'
          || !Number.isSafeInteger(record.version) || Number(record.version) < 1) throw new Error('Memory 单元记录非法');
        state.register(space, parent, key, record as UnitRecord);
      }
      if (space !== 'part') {
        state.records.set(recordId(space, parent),
          { space, key: parent, slices: table as Record<string, UnitRecord>, createdAt: Number.NEGATIVE_INFINITY });
      }
    }
  }
  state.root = root as Record<string, Json>;
  state.data = data as Namespace;
  // 已通过 checkMarker 的标记作为 sys 的合法基线，必须早于任何 sys 写入建立。
  state.sysText = JSON.stringify(data.sys);
  state.sysEpoch = data.sys.epoch;
  state.structural = true; // reset 后首次提交完整编码，未声明的单元也要原样保留。
};

/**
 * @description 校验配置并分配实例状态；不读取平台，不发布可用存储能力。
 * @param options 命名空间、身份、schema、平台端口及抽查配置。
 * @returns 尚未加载的独立 Runtime。
 * @throws {TypeError} 名称、签名、schema 或抽查数量非法。
 */
export const createRuntime = (options: MemoryOptions): Runtime => {
  checkKey(options.namespace);
  if (!options.signature || !Number.isSafeInteger(options.schema) || options.schema < 1
    || !Number.isSafeInteger(options.auditUnits ?? 0) || (options.auditUnits ?? 0) < 0) throw new TypeError('Memory 配置非法');
  const state: Runtime = {
    // units: { [JSON(space,parent,key)]: 单元 }；records: { [JSON(space,key)]: 实体及其切片表 }。
    // 两张索引跨 tick 保留；dirty 保存待提交单元，三者由 dispose 清空。
    options: { ...options }, units: new Map(), records: new Map(), dirty: new Set(),
    active: true, loaded: false, root: {}, structural: false, written: false, committing: false,
    sizes: { total: 0, spaces: { sys: 0, part: 0, rooms: 0, creeps: 0, flags: 0 }, owners: {} },
    /**
     * @description 统一执行实例生命周期与重入检查，不访问平台。
     * @returns 无返回值；正常结束表示可以继续访问。
     * @throws {Error} 实例已销毁、处于提交中、加载失败或尚无数据。
     */
    check() {
      if (!state.active) throw new Error('Memory 实例已销毁');
      if (state.committing) throw new Error('提交期间不可重入 Memory');
      if (state.failure !== undefined) throw state.failure;
      if (!state.facts || !state.data) throw new Error('Memory 尚未加载或初始化');
    },
    /**
     * @description 登记已接入根表的单元，加载默认不标脏，新建时可同时标记结构变化。
     * @param space 存储空间。
     * @param parent 分区 owner 或实体名称。
     * @param key 分区 localId 或实体切片 owner。
     * @param record 根表持有的单元包络引用。
     * @param dirty 是否标记新增脏单元，默认 false。
     * @returns 新分配的运行时单元。
     */
    register(space, parent, key, record, dirty = false) {
      const id = unitId(space, parent, key);
      const unit: Unit = { id, space, owner: space === 'part' ? parent : key, record,
        dirty: state.dirty, check: state.check, active: true, needsValidation: false, isolated: false };
      state.units.set(id, unit);
      if (dirty) { state.dirty.add(unit); state.structural = true; }
      return unit;
    },
  };
  return state;
};

/** 接管标记：带有此属性的全局 Memory 值是 takeoverMemory 安装的临时对象。模块级常量，不可变。 */
const TAKEOVER = Symbol('kernel.memory.takeover');

/**
 * @description 把全局 Memory 换成空的临时对象，使引擎自身与原生 *.memory 的读写只落在临时对象上（架构 6.6）。
 * 与具体 Memory 实例无关，不解析文本，同一 tick 内重复调用无副作用；入口每 tick 最先调用，
 * 装配失败或冷却期只运行保底时同样适用（内核设计第 6 节）。只检查属性描述符，不触发引擎的惰性 getter。
 * @param target 安装全局 Memory 的对象；游戏中为 globalThis。
 * @returns 无返回值。
 * @throws {Error} Memory 已被读取（属性已变为非临时对象的值）或访问器不可替换。
 */
export const takeoverMemory = (target: object): void => {
  const descriptor = Object.getOwnPropertyDescriptor(target, 'Memory');
  const value: unknown = descriptor && !descriptor.get ? descriptor.value : undefined;
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, TAKEOVER)) return;
  if (!descriptor?.get || !descriptor.configurable) throw new Error('Memory 接管过晚或平台访问器不可替换');
  const temporary = {};
  Object.defineProperty(temporary, TAKEOVER, { value: true });
  Object.defineProperty(target, 'Memory', { value: temporary, writable: true, enumerable: true, configurable: true });
};

/**
 * @description 必须早于任何原生 Memory 访问调用，接管临时全局值并更新 tick 事实。
 * 每 tick 更新临时全局值及事实；真实文本只在首次解析，待确认写入只做字符串比较。
 * @param state 当前实例状态。
 * @param facts 当前 tick 的时间与实体事实快照。
 * @returns 本项目命名空间缺失返回 empty（根中可能有只读保留的其他键），数据可用返回 ready；
 * empty 本身不授予初始化权限。
 * @throws {Error} 实例已销毁、tick 非法、接管过晚、平台属性不可替换或加载失败。
 * @throws {*} 平台读取异常原样传播。
 */
export const beginTick = (state: Runtime, facts: TickFacts): 'empty' | 'ready' => {
  if (!state.active) throw new Error('Memory 实例已销毁');
  if (!Number.isSafeInteger(facts.time) || facts.time < 0 || facts.time < (state.facts?.time ?? -1)) throw new Error('tick 顺序非法');
  if (facts.time === state.facts?.time) {
    if (state.failure !== undefined) throw state.failure;
    return state.data ? 'ready' : 'empty';
  }
  // 入口可能已在本 tick 先行接管；takeoverMemory 识别自己的临时对象，否则按访问器状态接管或报接管过晚。
  takeoverMemory(state.options.platform.target);
  state.previousCreeps = state.facts?.time === facts.time - 1 ? state.facts.creeps : undefined;
  state.facts = { ...facts, creeps: new Set(facts.creeps), flags: new Set(facts.flags) };
  state.written = false;
  state.committing = false;
  if (state.failure !== undefined) throw state.failure;
  if (!state.loaded) {
    state.loaded = true;
    // 文本只解析一次：概要与索引共用同一解析结果。概要先于结构校验计算，加载失败时 boot 仍能取得。
    // 平台读取或 JSON 解析失败时概要为 UNPARSED_SUMMARY；空白文本不调用 JSON.parse。
    state.summary = UNPARSED_SUMMARY;
    try {
      const text = state.options.platform.read();
      state.text = text;
      const root: unknown = text.trim() === '' ? {} : JSON.parse(text);
      state.summary = summarize(root, state.options.namespace, state.options);
      load(state, root);
    } catch (error) { state.failure = error; throw error; }
  }
  if (state.pending !== undefined) {
    // write 成功后仍可能因 segment 等收尾检查丢弃整 tick；保留 heap 数据并强制重拼。
    // 此路径要求宿主独占真实写入口；它不负责合并外部作者对原始文本的修改。
    if (state.options.platform.read() !== state.pending) state.structural = true;
    else state.pending = undefined;
  }
  return state.data ? 'ready' : 'empty';
};

/**
 * @description 在缺少本项目命名空间的根上显式创建命名空间；校验并复制 marker 后安装引用，commit 时再写回。
 * 根中已有的其他键原样保留并排在前面，不清空、不解读；需要清空时由 boot 经特权端口另行执行。
 * @param state 已执行 beginTick 且结果为 empty 的实例状态。
 * @param marker 已由宿主启动流程授权的完整项目标记。
 * @returns 无返回值；在根上加入命名空间并标记结构变化。
 * @throws {Error} 实例不可初始化、命名空间已存在、标记不匹配或标记不能作为 JSON 复制。
 */
export const initialize = (state: Runtime, marker: ProjectMarker): void => {
  if (!state.active || !state.loaded || !state.facts || state.failure !== undefined) throw new Error('Memory 不可初始化');
  if (state.data || Object.hasOwn(state.root, state.options.namespace)) throw new Error('本项目命名空间已存在');
  if (!checkMarker(marker, state.options)) throw new Error('初始化标记不匹配');
  state.data = { sys: copyJson(marker), part: {}, rooms: {}, creeps: {}, flags: {} };
  state.root[state.options.namespace] = state.data;
  state.sysText = JSON.stringify(state.data.sys);
  state.sysEpoch = state.data.sys.epoch;
  state.structural = true;
};

/**
 * @description 整体替换根为只含本项目命名空间的新根，清除加载失败的锁存（boot 特权端口的 clearMemory）。
 * 其他根键、所有分区与实体数据一并丢弃；已发布的分区与切片访问器全部失效，sys 访问器继续指向新标记。
 * 与 initialize 一样不立即写入，下一次 commit 完整编码。能否清空（闸门、备份、普通模块是否已 setup）由宿主判断。
 * @param state 已执行过 beginTick 的实例状态；允许处于加载失败状态。
 * @param marker 已由宿主生成的完整项目标记。
 * @returns 无返回值；替换根并标记结构变化。
 * @throws {Error} 实例已销毁、尚未开始首个 tick、正在提交、标记不匹配或标记不能作为 JSON 复制。
 */
export const clear = (state: Runtime, marker: ProjectMarker): void => {
  if (!state.active || !state.loaded || !state.facts) throw new Error('Memory 不可清空');
  if (state.committing) throw new Error('提交期间不可重入 Memory');
  if (!checkMarker(marker, state.options)) throw new Error('清空标记不匹配');
  // 先完成会抛错的复制，再改状态，失败时原数据不变。
  const sys = copyJson(marker);
  // 加载失败时 load 可能已登记部分单元，这里一并撤销。
  for (const unit of state.units.values()) unit.active = false;
  state.units.clear(); state.records.clear(); state.dirty.clear();
  state.data = { sys, part: {}, rooms: {}, creeps: {}, flags: {} };
  state.root = { [state.options.namespace]: state.data };
  state.sysText = JSON.stringify(sys);
  state.sysEpoch = sys.epoch;
  if (state.sysUnit) { state.sysUnit.isolated = false; state.sysUnit.needsValidation = false; }
  state.failure = undefined;
  state.structural = true;
};

/**
 * @description 调用宿主告警端口并隔离其异常，避免日志失败打断持久化事务。
 * @param state 提供平台告警端口的实例状态。
 * @param message 不含原始 Memory 或业务数据的告警正文。
 * @returns 无返回值；宿主告警异常被捕获，不向调用方传播。
 */
export const warn = (state: Runtime, message: string): void => {
  try { state.options.platform.warn(message); } catch { /* 宿主日志异常不能改变持久化结果。 */ }
};
