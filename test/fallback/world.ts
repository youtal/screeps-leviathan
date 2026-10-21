/**
 * 文件摘要：保底循环测试用的精简游戏世界替身。
 *
 * 所属位置：test/fallback/，测试基础设施，不进入游戏构建产物。只实现 src/fallback.ts 用到的游戏 API：
 * 全局常量、Game、PathFinder、房间的 find、位置的距离计算，以及 creep、spawn、tower 等对象的动作。
 * 动作只记入 actions 日志、不改变世界状态，测试据此断言保底循环提交了哪些动作。
 * 访问全局 Memory 或 RawMemory 即抛错，用于证明保底循环不触碰持久化存储。
 * 状态：每次 installWorld 创建新的世界并覆盖全局对象，测试之间互不影响。
 */

/** 一条被记录的动作：执行者名称或 id、动作名、目标 id 或参数。 */
export type Action = [actor: string, action: string, target?: unknown];

/** 替身对象的公共字段；pos 指向所属房间。 */
export interface FakeObject {
  id: string;
  pos: FakePos;
  [key: string]: unknown;
}

/** 替身位置：Chebyshev 距离，同房间比较。 */
export interface FakePos {
  x: number;
  y: number;
  roomName: string;
  [key: string]: unknown;
}

const CONSTANTS: Record<string, unknown> = {
  OK: 0, WORK: 'work', CARRY: 'carry', MOVE: 'move', ATTACK: 'attack', HEAL: 'heal',
  RESOURCE_ENERGY: 'energy', TOWER_ENERGY_COST: 10,
  FIND_MY_CREEPS: 102, FIND_HOSTILE_CREEPS: 103, FIND_SOURCES_ACTIVE: 104, FIND_SOURCES: 105, FIND_DROPPED_RESOURCES: 106,
  FIND_STRUCTURES: 107, FIND_MY_STRUCTURES: 108, FIND_MY_SPAWNS: 112, FIND_MY_CONSTRUCTION_SITES: 114, FIND_MINERALS: 116,
  FIND_TOMBSTONES: 118, FIND_RUINS: 123,
  OBSTACLE_OBJECT_TYPES: ['spawn', 'creep', 'powerCreep', 'source', 'mineral', 'deposit', 'controller', 'constructedWall', 'extension',
    'link', 'storage', 'tower', 'observer', 'powerSpawn', 'powerBank', 'lab', 'terminal', 'nuker', 'factory', 'invaderCore'],
  STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_TOWER: 'tower', STRUCTURE_ROAD: 'road',
  STRUCTURE_CONTAINER: 'container', STRUCTURE_STORAGE: 'storage', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall',
  CONTROLLER_DOWNGRADE: { 1: 20000, 2: 10000, 3: 20000, 4: 40000, 5: 80000, 6: 120000, 7: 150000, 8: 200000 },
};

/**
 * @description 创建替身位置。
 * @param x 横坐标。
 * @param y 纵坐标。
 * @param roomName 所在房间名。
 * @returns 带距离计算方法的位置。
 */
export const pos = (x: number, y: number, roomName = 'W1N1'): FakePos => {
  const self: FakePos = { x, y, roomName };
  /**
   * @description 计算到对象或位置的 Chebyshev 距离；不同房间视为无穷远。
   * @param t 带 pos 的对象，或位置本身。
   * @returns 距离。
   */
  const range = (t: { pos?: FakePos } & Partial<FakePos>): number => {
    const p = (t.pos ?? t) as FakePos;
    return p.roomName === roomName ? Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) : Infinity;
  };
  Object.assign(self, {
    getRangeTo: range,
    /**
     * @description 判断是否与目标相邻（距离不超过 1）。
     * @param t 目标对象。
     * @returns 相邻时为 true。
     */
    isNearTo: (t: FakeObject) => range(t) <= 1,
    /**
     * @description 判断目标是否在给定范围内。
     * @param t 目标对象。
     * @param r 范围。
     * @returns 在范围内时为 true。
     */
    inRangeTo: (t: FakeObject, r: number) => range(t) <= r,
    /**
     * @description 测试中方向无关紧要，固定返回 1（TOP）。
     * @returns 方向常量 1。
     */
    getDirectionTo: () => 1,
    /**
     * @description 在对象列表或某个 FIND 类别中找出最近的对象。
     * @param input 对象列表，或 FIND 常量（从所在房间查找）。
     * @param opts 查找选项。
     * @param opts.filter 过滤函数。
     * @returns 最近的对象；没有候选时为 null。
     */
    findClosestByRange: (input: number | FakeObject[], opts?: { filter?: (o: FakeObject) => boolean }) => {
      const list = typeof input === 'number' ? world().rooms[roomName].find(input) as FakeObject[] : input;
      const matched = opts?.filter ? list.filter(opts.filter) : list;
      return matched.reduce<FakeObject | null>((best, o) => (best === null || range(o) < range(best) ? o : best), null);
    },
  });
  return self;
};

/**
 * @description 创建能量容器替身。
 * @param used 当前能量。
 * @param capacity 能量容量。
 * @returns 带 getUsedCapacity、getFreeCapacity、getCapacity 的 store。
 */
export const store = (used: number, capacity: number) => ({
  energy: used,
  /**
   * @description 当前能量。
   * @returns 能量数量。
   */
  getUsedCapacity: () => used,
  /**
   * @description 剩余容量。
   * @returns 容量减去当前能量。
   */
  getFreeCapacity: () => capacity - used,
  /**
   * @description 能量容量。
   * @returns 容量。
   */
  getCapacity: () => capacity,
});

/** 房间替身：find 按 FIND 类别返回预置对象并计数。 */
interface FakeRoom {
  name: string;
  /**
   * @description 按 FIND 类别返回预置的对象列表，可选过滤。
   * @param type FIND 常量。
   * @param opts 查找选项。
   * @param opts.filter 过滤函数。
   * @returns 对象列表；未预置的类别为空数组。
   */
  find(type: number, opts?: { filter?: (o: FakeObject) => boolean }): unknown[];
}

/** 替身成本矩阵：按坐标保存寻路回调写入的成本。 */
export interface FakeMatrix {
  /**
   * @description 读取某格的成本。
   * @param x 横坐标。
   * @param y 纵坐标。
   * @returns 写入过的成本；未写入时为 0。
   */
  get(x: number, y: number): number;
}

/** 当前安装的世界：installWorld 时替换。 */
interface World {
  rooms: Record<string, FakeRoom>;
  actions: Action[];
  /** 寻路次数。 */
  paths: number;
  /** room.find 的调用次数。 */
  finds: number;
  /** 每次寻路的选项，按调用顺序。 */
  searches: Record<string, unknown>[];
  /** 寻路回调返回的矩阵，按调用顺序；回调返回 false 时记为 null。 */
  matrices: (FakeMatrix | null)[];
  /** 是否有代码试图访问被守卫的 Memory 或 RawMemory；访问同时抛错。 */
  storageTouched: boolean;
}

/**
 * @description 取得当前安装的世界。
 * @returns 当前世界。
 * @throws {Error} 尚未调用 installWorld。
 */
const world = (): World => {
  const current = (globalThis as { __fallbackWorld?: World }).__fallbackWorld;
  if (!current) throw new Error('尚未安装测试世界');
  return current;
};

/**
 * @description 生成记录动作的方法：调用时把 [执行者, 动作, 目标] 记入日志并返回 OK。
 * @param actor 执行者名称或 id。
 * @param action 动作名。
 * @returns 记录动作的函数。
 */
export const act = (actor: string, action: string) => (target?: { id?: string } | unknown) => {
  world().actions.push([actor, action, (target as { id?: string } | undefined)?.id ?? target]);
  return 0;
};

/** creep 替身的构造参数。 */
export interface CreepSpec {
  name: string;
  at: FakePos;
  body: string[];
  energy?: number;
  capacity?: number;
  spawning?: boolean;
  hits?: number;
  fatigue?: number;
}

/**
 * @description 创建 creep 替身：有效部件数按 body 统计，动作全部记录。
 * @param spec creep 参数。
 * @param spec.name 名称，也用作动作日志中的执行者。
 * @param spec.at 位置。
 * @param spec.body 身体部件列表。
 * @param spec.energy 携带的能量，默认 0。
 * @param spec.capacity 携带容量，默认 50；无 CARRY 的 creep 应设为 0。
 * @param spec.spawning 是否在孵化中，默认 false；孵化中的 creep 不出现在 FIND_MY_CREEPS 中。
 * @param spec.hits 当前生命值，默认 100（上限 100）。
 * @param spec.fatigue 疲劳值，默认 0；大于 0 时本 tick 不能移动。
 * @returns creep 替身。
 */
export const creep = (spec: CreepSpec): FakeObject => {
  const { name, at, body, energy = 0, capacity = 50, spawning = false, hits = 100, fatigue = 0 } = spec;
  const self: FakeObject = {
    id: `creep-${name}`, name, pos: at, spawning, hits, hitsMax: 100, my: true, fatigue,
    store: store(energy, capacity),
    /**
     * @description 统计指定类型的有效部件数；替身不模拟受损，全部部件都有效。
     * @param type 部件类型。
     * @returns 部件数。
     */
    getActiveBodyparts: (type: string) => body.filter((part) => part === type).length,
  };
  for (const action of ['harvest', 'transfer', 'withdraw', 'pickup', 'upgradeController', 'move']) self[action] = act(name, action);
  Object.defineProperty(self, 'room', {
    /**
     * @description 返回 creep 所在房间的替身。
     * @returns 房间替身。
     */
    get: () => world().rooms[at.roomName],
  });
  return self;
};

/**
 * @description 创建建筑替身；spawn 与 tower 的动作会被记录。
 * @param type 建筑类型（STRUCTURE_* 的值）。
 * @param at 位置。
 * @param extra 额外字段，例如 store、spawning（spawn 未提供时为 null）、my。
 * @returns 建筑替身。
 */
export const structure = (type: string, at: FakePos, extra: Record<string, unknown> = {}): FakeObject => {
  const id = `${type}-${at.x}-${at.y}`;
  const self: FakeObject = { id, structureType: type, pos: at, my: true, ...extra };
  if (type === 'spawn') {
    const record = act(id, 'spawnCreep');
    Object.assign(self, {
      name: id, spawning: extra.spawning ?? null,
      /**
       * @description 模拟引擎的 spawnCreep：即使不传 memory 选项，也会读写全局 Memory.creeps[name]；成功时在 Game.creeps 中放入
       * 位于 spawn 坐标、spawning 恒为 true 的占位 creep，不改 spawn.spawning（engine 4.3.2 structures.js 第 1132–1160 行），再记录动作。
       * @param body 身体部件列表。
       * @param name creep 名称。
       * @returns OK。
       * @throws {Error} 全局 Memory 处于守卫状态时，读取即抛错。
       */
      spawnCreep: (body: string[], name: string) => {
        const memory = (globalThis as unknown as { Memory: { creeps?: Record<string, unknown> } }).Memory;
        memory.creeps ??= {};
        memory.creeps[name] = {};
        const game = (globalThis as unknown as { Game: { creeps: Record<string, FakeObject> } }).Game;
        game.creeps[name] = creep({ name, at, body, spawning: true });
        return record(body);
      },
      /**
       * @description 替身 spawn 总是可用（不受 RCL 数量限制）。
       * @returns true。
       */
      isActive: () => true,
    });
  }
  if (type === 'tower') Object.assign(self, { attack: act(id, 'attack'), heal: act(id, 'heal') });
  return self;
};

/** 房间替身的构造参数：按 FIND 类别提供对象。 */
export interface RoomSpec {
  name?: string;
  level?: number;
  ticksToDowngrade?: number;
  energyAvailable?: number;
  creeps?: FakeObject[];
  hostiles?: FakeObject[];
  structures?: FakeObject[];
  sources?: FakeObject[];
  dropped?: FakeObject[];
  tombstones?: FakeObject[];
  ruins?: FakeObject[];
  minerals?: FakeObject[];
  /** 己方建筑工地。 */
  sites?: FakeObject[];
  /** 为 true 时 room.find 一律抛错，用于验证房间级错误边界。 */
  broken?: boolean;
}

/** installWorld 的参数。 */
export interface WorldSpec {
  rooms: RoomSpec[];
  time?: number;
  shard?: string;
  /**
   * 是否提供 InterShardMemory，默认 true（官服）。提供时它是守卫对象：读取任何属性都记录到 storageTouched，
   * typeof 检测不触碰属性；为 false 时删除该全局，模拟私服。
   */
  interShard?: boolean;
  /** 每次读取 Game.cpu.getUsed() 返回的值序列；用尽后保持最后一个值。 */
  cpu?: number[];
  tickLimit?: number;
  /**
   * 全局 Memory 的状态：省略时为守卫（读取即抛错并记录）；提供对象时视为入口已接管，
   * 全局 Memory 即该临时对象，引擎内部的写入落在其上。
   */
  memory?: Record<string, unknown>;
}

/**
 * @description 安装测试世界：定义全局常量、Game、PathFinder，以及 Memory 与 RawMemory。
 * 与真实平台一致：FIND_MY_CREEPS 不含孵化中的 creep，Game.creeps 包含；寻路会调用 roomCallback。
 * @param spec 世界参数。
 * @param spec.rooms 房间列表。
 * @param spec.time Game.time，默认 1000。
 * @param spec.shard shard 名，默认 shard0。
 * @param spec.interShard 是否提供 InterShardMemory 守卫对象，默认 true。
 * @param spec.cpu Game.cpu.getUsed() 的读数序列，默认 [0]。
 * @param spec.tickLimit Game.cpu.tickLimit，默认 500。
 * @param spec.memory 入口已接管时的临时 Memory 对象；省略时 Memory 处于守卫状态。
 * @returns 世界对象：记录动作、寻路、find 调用、寻路矩阵与持久化存储访问。
 */
export const installWorld = (spec: WorldSpec): World => {
  const current: World = { rooms: {}, actions: [], paths: 0, finds: 0, searches: [], matrices: [], storageTouched: false };
  const g = globalThis as Record<string, unknown>;
  g.__fallbackWorld = current;
  Object.assign(g, CONSTANTS);
  const creeps: Record<string, FakeObject> = {};
  for (const r of spec.rooms) {
    const name = r.name ?? 'W1N1';
    const controller = { id: `controller-${name}`, my: true, level: r.level ?? 3, ticksToDowngrade: r.ticksToDowngrade ?? 19000, pos: pos(25, 25, name) };
    const structures = r.structures ?? [];
    const lists: Record<number, unknown[]> = {
      // FIND_SOURCES_ACTIVE 只含能量大于 0 的 source（未设 energy 的替身按活跃处理），FIND_SOURCES 含全部。
      102: (r.creeps ?? []).filter((c) => !c.spawning), 103: r.hostiles ?? [],
      104: (r.sources ?? []).filter((s) => ((s.energy as number | undefined) ?? 1) > 0), 105: r.sources ?? [],
      106: r.dropped ?? [], 107: structures, 108: structures.filter((s) => s.my !== false),
      112: structures.filter((s) => s.structureType === 'spawn'), 114: r.sites ?? [], 116: r.minerals ?? [],
      118: r.tombstones ?? [], 123: r.ruins ?? [],
    };
    current.rooms[name] = {
      name, controller, energyAvailable: r.energyAvailable ?? 300,
      /**
       * @description 按 FIND 类别返回预置的对象列表，可选过滤，并累计调用次数。
       * @param type FIND 常量。
       * @param opts 查找选项。
       * @param opts.filter 过滤函数。
       * @returns 对象列表；未预置的类别为空数组。
       * @throws {Error} 房间被设为 broken 时。
       */
      find: (type: number, opts?: { filter?: (o: FakeObject) => boolean }) => {
        current.finds += 1;
        if (r.broken) throw new Error(`房间 ${name} 查询失败`);
        const list = (lists[type] ?? []) as FakeObject[];
        return opts?.filter ? list.filter(opts.filter) : list;
      },
    } as FakeRoom;
    for (const c of r.creeps ?? []) creeps[c.name as string] = c;
  }
  const readings = [...(spec.cpu ?? [0])];
  g.Game = {
    time: spec.time ?? 1000, shard: { name: spec.shard ?? 'shard0' }, rooms: current.rooms, creeps,
    cpu: {
      limit: 20, tickLimit: spec.tickLimit ?? 500, bucket: 10000,
      /**
       * @description 依次返回预置的 CPU 读数，用尽后保持最后一个值。
       * @returns 已用 CPU。
       */
      getUsed: () => (readings.length > 1 ? readings.shift()! : readings[0]),
    },
  };
  g.PathFinder = {
    CostMatrix: class {
      /** { [y * 50 + x]: 成本 }。 */
      private readonly costs = new Map<number, number>();
      /**
       * @description 写入某格的成本。
       * @param x 横坐标。
       * @param y 纵坐标。
       * @param cost 成本。
       * @returns 无返回值。
       */
      set(x: number, y: number, cost: number) { this.costs.set(y * 50 + x, cost); }
      /**
       * @description 读取某格的成本。
       * @param x 横坐标。
       * @param y 纵坐标。
       * @returns 写入过的成本；未写入时为 0。
       */
      get(x: number, y: number) { return this.costs.get(y * 50 + x) ?? 0; }
    },
    /**
     * @description 计数一次寻路，记录选项，并像原生寻路一样对目标所在房间调用 roomCallback；直接返回以目标位置为第一步的路径。
     * @param from 起点（替身不使用）。
     * @param goal 目标与范围。
     * @param opts 寻路选项。
     * @returns 只含目标位置的路径。
     */
    search: (from: FakePos, goal: { pos: FakePos }, opts: Record<string, unknown> = {}) => {
      current.paths += 1;
      current.searches.push(opts);
      const callback = opts.roomCallback as ((room: string) => FakeMatrix | false) | undefined;
      if (callback) {
        const matrix = callback(goal.pos.roomName);
        current.matrices.push(matrix === false ? null : matrix);
      }
      return { path: [goal.pos], incomplete: false };
    },
  };
  if (spec.interShard ?? true) {
    // 值而不是 getter：对全局做 typeof 会执行 getter，守卫只拦截对其属性的读取。只记录不抛错：
    // Jest 清理环境时会读取全局对象的属性，抛错会使整个测试文件失败；用例以 storageTouched 断言。
    const guard = new Proxy({}, {
      /**
       * @description 记录对 InterShardMemory 字符串属性的读取（如 getLocal、setLocal）；符号属性来自运行环境的内省，不计。
       * @param _target 被代理的空对象。
       * @param key 属性键。
       * @returns undefined。
       */
      get: (_target, key) => { if (typeof key === 'string') current.storageTouched = true; return undefined; },
    });
    Object.defineProperty(g, 'InterShardMemory', { configurable: true, writable: true, value: guard });
  } else {
    delete g.InterShardMemory;
  }
  if (spec.memory) {
    Object.defineProperty(g, 'Memory', { configurable: true, writable: true, value: spec.memory });
  }
  for (const key of spec.memory ? ['RawMemory'] : ['Memory', 'RawMemory']) {
    Object.defineProperty(g, key, {
      configurable: true,
      /**
       * @description 记录持久化存储被访问，并抛错。
       * @returns 不返回。
       * @throws {Error} 总是抛出。
       */
      get: () => { current.storageTouched = true; throw new Error(`保底循环访问了 ${key}`); },
    });
  }
  return current;
};
