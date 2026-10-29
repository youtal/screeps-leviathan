/**
 * 文件摘要：独立保底循环，正常循环无法运行时维持本房的生存闭环（架构设计 5.7，模块设计 docs/design/fallback.md）。
 *
 * 所属位置：src/fallback.ts，根目录独立入口，只由 main.ts 调用；不导入任何项目模块（含 lib），由边界测试检查。
 * 能力：tower 防御与治疗、缺少采集者时应急孵化、简单本房能量物流、防降级升级。
 * 约束：保底代码自身不读写 Memory、RawMemory、InterShardMemory 与原生 memory，不用 moveTo（可能写入路径缓存），
 * 不建立持久任务。引擎的 spawnCreep 内部会访问 Memory.creeps，须由入口在调用前完成 Memory 接管（内核骨架设计第 6 节）。
 * 状态：每 tick 的房间快照、分配、预留与寻路计数都保存在本次调用创建的对象中，调用结束即丢弃，没有模块级可变状态。
 * 寻路名额（审计 S-19）：全局每 tick FB_PATH_LIMIT 次。工作阶段先处理所有房间的防降级升级者，再按房间轮转逐个处理 creep，
 * 前面房间的普通移动不会先耗尽名额；预留只在提交了动作或移动时保留，寻路未提交移动时撤回，不挡住紧挨目标的 creep。
 * 异常：房间与单个资产各有独立错误边界，局部异常只记录日志，不影响其他房间与资产。
 * CPU：处理每个房间与资产前检查 Game.cpu.getUsed() 是否已到上限（含退出余量），到达即停止本 tick 的剩余工作。
 */

/** 退出余量（CPU）：上限减去此值后不再开始新的工作。 */
const FB_CPU_RESERVE = 2;
/** 防降级应急阈值占 CONTROLLER_DOWNGRADE[level] 的比例。 */
const FB_DOWNGRADE_RATIO = 0.25;
/** 每 tick 寻路次数上限。 */
const FB_PATH_LIMIT = 20;
/** 单次寻路的 maxOps。 */
const FB_PATH_OPS = 1000;

type FillTarget = StructureSpawn | StructureExtension | StructureTower;
type Supply =
  | Resource
  | Tombstone
  | Ruin
  | StructureContainer
  | StructureStorage;

/** 一次 runFallback 调用的临时状态，调用结束即丢弃。 */
interface TickState {
  /** 本 tick 的 CPU 上限（已扣除退出余量）。 */
  readonly cap: number;
  /** 本 tick 已使用的寻路次数。 */
  paths: number;
  /** { [对象 id]: 本 tick 剩余可分配量 }：供给为剩余能量，补能目标为剩余空余容量；首次访问时取实际值。 */
  readonly reserved: Map<string, number>;
  /** 本 tick 已分配的应急 creep 名称，避免同 tick 重名。 */
  readonly names: Set<string>;
  /** { [房间名]: 本 tick 构建的成本矩阵 }，每个房间至多构建一次。 */
  readonly matrices: Map<string, CostMatrix>;
}

/** 一个自有房间在本 tick 的事实快照：每类对象只查询一次，各阶段复用。 */
interface RoomInfo {
  readonly room: Room;
  readonly controller: StructureController;
  /** 不含孵化中的 creep（与 FIND_MY_CREEPS 一致）。 */
  readonly creeps: Creep[];
  readonly hostiles: Creep[];
  readonly towers: StructureTower[];
  readonly spawns: StructureSpawn[];
  readonly structures: Structure[];
  /** 原生寻路不认识、移动结算却会阻挡的对象位置：source、mineral、controller 与己方阻挡类工地。 */
  readonly obstacles: RoomPosition[];
  /** 按优先级分组的补能目标：有敌人时 tower 组在最前。 */
  readonly fill: FillTarget[][];
  readonly supply: Supply[];
  /** 活跃的 source（能量大于 0）。 */
  readonly sources: Source[];
  /** 全部 source，含暂时枯竭的；矿工据此守在所守的 source 旁（审计 S-21）。 */
  readonly allSources: Source[];
  /** 控制器剩余降级时间低于应急阈值。 */
  readonly emergency: boolean;
  /** 防降级应急时本 tick 优先升级的工人；不应急或没有合适工人时为 undefined。 */
  upgrader?: Creep;
}

/**
 * @description 保底循环入口：依次执行防御、应急孵化与 creep 工作，CPU 到达上限即停止。
 * @returns 无返回值；直接向游戏提交动作。
 */
export const runFallback = (): void => {
  const ceiling = Game.cpu.bucket < 1000 ? Game.cpu.limit : Game.cpu.tickLimit;
  const state: TickState = {
    cap: ceiling - FB_CPU_RESERVE,
    paths: 0,
    reserved: new Map(),
    names: new Set(),
    matrices: new Map(),
  };
  const rooms: RoomInfo[] = [];
  for (const room of Object.values(Game.rooms)) {
    if (!cpuOk(state)) return;
    if (room.controller?.my)
      guard(`房间 ${room.name}`, () => rooms.push(collect(room)));
  }
  for (const info of rooms) {
    if (!cpuOk(state)) return;
    guard(`防御 ${info.room.name}`, () => {
      for (const tower of info.towers) {
        if (!cpuOk(state)) return;
        guard(`tower ${tower.id}`, () => defend(tower, info));
      }
    });
  }
  for (const info of rooms) {
    if (!cpuOk(state)) return;
    guard(`孵化 ${info.room.name}`, () => spawnIfNeeded(info, state));
  }
  // 工作阶段（审计 S-19）：先处理所有房间的防降级升级者，再按房间轮转，每轮从每个房间各取一个 creep。
  // queues: [房间快照, 除升级者外待处理的 creep]，按房间顺序。
  const queues: (readonly [RoomInfo, Creep[]])[] = [];
  for (const info of rooms) {
    if (!cpuOk(state)) return;
    guard(`工作 ${info.room.name}`, () => {
      info.upgrader = chooseUpgrader(info);
      const upgrader = info.upgrader;
      if (upgrader)
        guard(`creep ${upgrader.name}`, () => work(upgrader, info, state));
      queues.push([info, info.creeps.filter((c) => c !== upgrader)]);
    });
  }
  for (let i = 0, more = true; more; i += 1) {
    more = false;
    for (const [info, creeps] of queues) {
      if (i >= creeps.length) continue;
      more = true;
      if (!cpuOk(state)) return;
      guard(`creep ${creeps[i].name}`, () => work(creeps[i], info, state));
    }
  }
};

/**
 * @description 在独立错误边界中执行一项工作，异常只记录、不向外传播。
 * @param label 日志中标识该房间或资产的文本。
 * @param fn 要执行的工作。
 * @returns 无返回值。
 */
const guard = (label: string, fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    console.log(`[fallback] ${label}: ${String(error)}`);
  }
};

/**
 * @description 判断本 tick 是否还能开始新的工作。
 * @param state 本 tick 状态。
 * @returns 已用 CPU 低于上限时为 true。
 */
const cpuOk = (state: TickState): boolean => Game.cpu.getUsed() < state.cap;

/**
 * @description 读取有效部件数；读取失败时按 0 处理，供跨 creep 的筛选使用，避免一个异常 creep 中断整个房间。
 * @param creep 己方 creep。
 * @param type 部件类型。
 * @returns 有效部件数。
 */
const parts = (creep: Creep, type: BodyPartConstant): number => {
  try {
    return creep.getActiveBodyparts(type);
  } catch {
    return 0;
  }
};

/**
 * @description 收集一个自有房间在本 tick 需要的对象，每类对象只查询一次。
 * @param room 自有房间。
 * @returns 本 tick 的房间事实快照。
 */
const collect = (room: Room): RoomInfo => {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  const mine = room.find(FIND_MY_STRUCTURES);
  const structures = room.find(FIND_STRUCTURES);
  const towers = mine.filter(
    (s): s is StructureTower => s.structureType === STRUCTURE_TOWER,
  );
  const spawns = mine.filter(
    (s): s is StructureSpawn => s.structureType === STRUCTURE_SPAWN,
  );
  const extensions = mine.filter(
    (s): s is StructureExtension => s.structureType === STRUCTURE_EXTENSION,
  );
  const needy = towers.filter(
    (t) =>
      hostiles.length > 0 ||
      t.store.getUsedCapacity(RESOURCE_ENERGY) <
        t.store.getCapacity(RESOURCE_ENERGY) / 2,
  );
  const stores = structures.filter(
    (s): s is StructureContainer | StructureStorage =>
      s.structureType === STRUCTURE_CONTAINER ||
      s.structureType === STRUCTURE_STORAGE,
  );
  const controller = room.controller!;
  const sources = room.find(FIND_SOURCES);
  const blocking = room
    .find(FIND_MY_CONSTRUCTION_SITES)
    .filter((s) =>
      (OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType),
    );
  const threshold =
    (CONTROLLER_DOWNGRADE[controller.level] ?? 0) * FB_DOWNGRADE_RATIO;
  const emergency =
    controller.ticksToDowngrade !== undefined &&
    controller.ticksToDowngrade < threshold;
  return {
    room,
    controller,
    hostiles,
    towers,
    spawns,
    structures,
    emergency,
    creeps: room.find(FIND_MY_CREEPS),
    obstacles: [
      ...sources,
      ...room.find(FIND_MINERALS),
      controller,
      ...blocking,
    ].map((o) => o.pos),
    fill:
      hostiles.length > 0
        ? [needy, spawns, extensions]
        : [spawns, extensions, needy],
    supply: [
      ...room.find(FIND_DROPPED_RESOURCES, {
        /**
         * @description 只取掉落的能量。
         * @param r 掉落的资源。
         * @returns 是能量时为 true。
         */
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      }),
      ...room.find(FIND_TOMBSTONES),
      ...room.find(FIND_RUINS),
      ...stores,
    ],
    sources: room.find(FIND_SOURCES_ACTIVE),
    allSources: sources,
  };
};

/**
 * @description 防降级应急时选出本 tick 优先升级的工人：先选带能且能升级的（可移动，或固定但已在升级范围内），
 * 都没有时选最近的可移动工人先去取能。不应急时返回 undefined。
 * @param info 房间的事实快照。
 * @returns 选中的工人；不应急或没有合适工人时为 undefined。
 */
const chooseUpgrader = (info: RoomInfo): Creep | undefined => {
  if (!info.emergency) return undefined;
  const workers = info.creeps.filter(
    (c) => parts(c, WORK) > 0 && parts(c, CARRY) > 0,
  );
  const loaded = workers.filter(
    (c) =>
      c.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
      (parts(c, MOVE) > 0 || c.pos.inRangeTo(info.controller, 3)),
  );
  const mobile = workers.filter((c) => parts(c, MOVE) > 0);
  return (
    info.controller.pos.findClosestByRange(
      loaded.length > 0 ? loaded : mobile,
    ) ?? undefined
  );
};

/**
 * @description tower 攻击最近的敌方 creep；没有敌人且能量不低于容量一半时，治疗最近的受伤己方 creep。
 * @param tower 己方 tower。
 * @param info 所在房间的事实快照。
 * @returns 无返回值。
 */
const defend = (tower: StructureTower, info: RoomInfo): void => {
  if (tower.store.getUsedCapacity(RESOURCE_ENERGY) < TOWER_ENERGY_COST) return;
  if (info.hostiles.length > 0) {
    const target = tower.pos.findClosestByRange(info.hostiles);
    if (target) tower.attack(target);
    return;
  }
  if (
    tower.store.getUsedCapacity(RESOURCE_ENERGY) <
    tower.store.getCapacity(RESOURCE_ENERGY) / 2
  )
    return;
  const hurt = tower.pos.findClosestByRange(
    info.creeps.filter((c) => c.hits < c.hitsMax),
  );
  if (hurt) tower.heal(hurt);
};

/**
 * @description 判断 creep 是否为可用采集者：有有效 WORK，并且能移动或已紧挨 source；与 work 的实际驱动一致（含无 CARRY 矿工）。
 * @param creep 不在孵化中的己方 creep。
 * @param info 所在房间的事实快照。
 * @returns 可用时为 true。
 */
const canHarvest = (creep: Creep, info: RoomInfo): boolean =>
  parts(creep, WORK) > 0 &&
  (parts(creep, MOVE) > 0 || info.sources.some((s) => creep.pos.isNearTo(s)));

/**
 * @description 房间没有可用采集者、也没有正在孵化的带 WORK 接替者时，由空闲 spawn 用 200 能量孵化 [WORK, CARRY, MOVE]。
 * 接替者从 spawn.spawning 对应的 Game.creeps 判断（FIND_MY_CREEPS 不含孵化中的 creep）。spawn.spawning 只反映 tick 起点的状态：
 * 正常循环在同一 tick 成功调用 spawnCreep 时，引擎只在 Game.creeps 中放入一个位于 spawn 坐标、spawning 恒为 true 的占位对象，
 * 不改 spawning，而同一对象的同名 intent 后者覆盖前者（engine 4.3.2 structures.js 第 1132–1160 行，driver runtime.js）。
 * 所以另查 Game.creeps 中位于 spawn 坐标、正在孵化的 creep：这样的 spawn 视为忙碌，带 WORK 的视为接替者（审计 S-18）。
 * 遍历 Game.creeps 只在房间缺少可用采集者时发生。
 * @param info 房间的事实快照。
 * @param state 本 tick 状态，记录已分配名称。
 * @returns 无返回值。
 */
const spawnIfNeeded = (info: RoomInfo, state: TickState): void => {
  if (info.creeps.some((c) => canHarvest(c, info))) return;
  const hatching = Object.values(Game.creeps).filter(
    (c) => c.spawning && c.pos.roomName === info.room.name,
  );
  /**
   * @description 找出位于 spawn 坐标、正在孵化的 creep（含本 tick 刚调用 spawnCreep 的占位对象）。
   * @param s spawn。
   * @returns 正在孵化的 creep；没有时为 undefined。
   */
  const at = (s: StructureSpawn): Creep | undefined =>
    hatching.find((c) => c.pos.x === s.pos.x && c.pos.y === s.pos.y);
  const pending = info.spawns.some((s) => {
    const name = s.spawning?.name;
    const creep = name === undefined ? at(s) : Game.creeps[name];
    return creep !== undefined && parts(creep, WORK) > 0;
  });
  if (pending || info.room.energyAvailable < 200) return;
  const spawn = info.spawns.find(
    (s) => !s.spawning && at(s) === undefined && s.isActive(),
  );
  if (!spawn) return;
  // 身份用的 shard 名（架构 11.3 的 here）：有 InterShardMemory 时取 Game.shard.name，否则为 x。私服的 driver 会注入
  // Game.shard，名称是服务器主机名（F7），可能含 "-" 且随容器重建变化，所以不能用 Game.shard 是否存在来判断。
  // typeof 只做特性检测，不读写 InterShardMemory 的内容（5.7）。
  const shard =
    typeof InterShardMemory !== "undefined" && Game.shard
      ? Game.shard.name
      : "x";
  const prefix = `fb-${shard}-${Game.time.toString(36)}-`;
  let seq = 0;
  while (
    Game.creeps[prefix + seq] !== undefined ||
    state.names.has(prefix + seq)
  )
    seq += 1;
  state.names.add(prefix + seq);
  spawn.spawnCreep([WORK, CARRY, MOVE], prefix + seq);
};

/**
 * @description 读取对象在本 tick 的剩余可分配量；首次访问时以实际值初始化。
 * @param state 本 tick 状态。
 * @param id 对象 id。
 * @param actual 对象当前的实际量。
 * @returns 剩余可分配量。
 */
const remaining = (state: TickState, id: string, actual: number): number => {
  const value = state.reserved.get(id);
  return value === undefined ? actual : value;
};

/**
 * @description 取供给中可提取的能量。
 * @param supply 掉落资源、墓碑、废墟、container 或 storage。
 * @returns 能量数量。
 */
const supplyEnergy = (supply: Supply): number =>
  "amount" in supply
    ? supply.amount
    : supply.store.getUsedCapacity(RESOURCE_ENERGY);

/**
 * @description 取补能目标的空余容量。
 * @param target spawn、extension 或 tower。
 * @returns 空余能量容量。
 */
const fillFree = (target: FillTarget): number =>
  target.store.getFreeCapacity(RESOURCE_ENERGY);

/**
 * @description 撤回 pick 的预留：creep 本 tick 没有提交动作或移动时调用，让其他 creep 仍能使用该目标（审计 S-19）。
 * @param state 本 tick 状态。
 * @param id 目标 id。
 * @param amount 当初预留的量。
 * @returns 无返回值。
 */
const unpick = (state: TickState, id: string, amount: number): void => {
  const value = state.reserved.get(id);
  if (value !== undefined) state.reserved.set(id, value + amount);
};

/**
 * @description 为 creep 挑选最近的、仍有剩余的目标，并按 amount 预留。
 * @template T 目标类型。
 * @param creep 执行者。
 * @param candidates 候选目标。
 * @param actual 取目标当前实际量的函数。
 * @param amount 本次预留量。
 * @param state 本 tick 状态。
 * @returns 选中的目标；没有可用目标时为 null。
 */
const pick = <T extends _HasId & RoomObject>(
  creep: Creep,
  candidates: T[],
  actual: (t: T) => number,
  amount: number,
  state: TickState,
): T | null => {
  const open = candidates.filter((t) => remaining(state, t.id, actual(t)) > 0);
  const target = creep.pos.findClosestByRange(open);
  if (target)
    state.reserved.set(
      target.id,
      remaining(state, target.id, actual(target)) - amount,
    );
  return target;
};

/**
 * @description 矿工守在所守的 source 旁（审计 S-21）：紧挨某个 source（活跃与否都算）时不离开，source 有能量就采集，
 * 装满后多出的能量按引擎规则落地或进入脚下的 container；source 暂时枯竭时原地等待它再生。
 * @param creep 矿工型 creep。
 * @param info 所在房间的事实快照。
 * @returns 紧挨 source（本 tick 已处理）时为 true；不紧挨任何 source 时为 false，由调用方按其他分工处理。
 */
const holdSource = (creep: Creep, info: RoomInfo): boolean => {
  const source = info.allSources.find((s) => creep.pos.isNearTo(s));
  if (!source) return false;
  // 是否有能量以本 tick 的活跃 source（FIND_SOURCES_ACTIVE）为准，与其他分工的口径一致。
  if (info.sources.includes(source)) creep.harvest(source);
  return true;
};

/**
 * @description 处理一个 creep，每 tick 至多一个工作动作和一次移动：防降级升级者优先升级；固定 creep 只做原地动作；
 * 矿工型 creep（没有 CARRY，或 WORK ≥ 5 且 CARRY ≤ 1，即 app.config 的矿工体型）紧挨 source 时守在原地；
 * 无 CARRY 的工人只采集（能量落地）；其余按工人或搬运者补能、取能。
 * @param creep 不在孵化中的己方 creep。
 * @param info 所在房间的事实快照。
 * @param state 本 tick 状态。
 * @returns 无返回值。
 */
const work = (creep: Creep, info: RoomInfo, state: TickState): void => {
  const hasWork = creep.getActiveBodyparts(WORK) > 0;
  const carry = creep.getActiveBodyparts(CARRY) > 0;
  const energy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  if (creep.getActiveBodyparts(MOVE) === 0) {
    stationary(creep, info, state, hasWork);
    return;
  }
  // 矿工体型按部件识别：规划的矿工为 WORK×5 加 MOVE，link 阶段加 1 CARRY（app.config 第 3 节）。被选为防降级升级者时以升级为先。
  const miner =
    hasWork &&
    (!carry ||
      (creep.getActiveBodyparts(WORK) >= 5 &&
        creep.getActiveBodyparts(CARRY) <= 1));
  if (miner && creep !== info.upgrader && holdSource(creep, info)) return;
  if (!carry) {
    if (hasWork) mine(creep, info, state);
    return;
  }
  if (creep === info.upgrader) {
    if (energy > 0) upgrade(creep, info, state);
    else acquire(creep, info, state, true);
    return;
  }
  if (energy > 0) {
    // 采集中途不离开：紧挨活跃 source 且未装满时继续采集，否则每采到一次就往返一趟，几乎运不回能量。
    const source =
      hasWork && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        ? info.sources.find((s) => creep.pos.isNearTo(s))
        : undefined;
    if (source) creep.harvest(source);
    else if (!deliver(creep, info, state) && hasWork)
      upgrade(creep, info, state);
    return;
  }
  acquire(creep, info, state, hasWork);
};

/**
 * @description 固定 creep 的原地动作，按优先级至多提交一个：防降级升级、向相邻补能目标转移、采集相邻 source
 * （空余容量不足时多出的能量落地）、在范围内升级、提取相邻能量；转移与提取都使用当 tick 预留。
 * @param creep 没有有效 MOVE 的 creep。
 * @param info 所在房间的事实快照。
 * @param state 本 tick 状态。
 * @param hasWork 是否有有效 WORK。
 * @returns 无返回值。
 */
const stationary = (
  creep: Creep,
  info: RoomInfo,
  state: TickState,
  hasWork: boolean,
): void => {
  const energy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const inRange = creep.pos.inRangeTo(info.controller, 3);
  if (creep === info.upgrader && energy > 0 && inRange) {
    creep.upgradeController(info.controller);
    return;
  }
  if (energy > 0) {
    const near = info.fill.flat().filter((t) => creep.pos.isNearTo(t));
    const target = pick(creep, near, fillFree, energy, state);
    if (target) {
      creep.transfer(target, RESOURCE_ENERGY);
      return;
    }
  }
  const source = hasWork
    ? info.sources.find((s) => creep.pos.isNearTo(s))
    : undefined;
  if (source) {
    creep.harvest(source);
    return;
  }
  if (hasWork && energy > 0 && inRange) {
    creep.upgradeController(info.controller);
    return;
  }
  const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
  if (free <= 0) return;
  const supply = pick(
    creep,
    info.supply.filter((s) => creep.pos.isNearTo(s)),
    supplyEnergy,
    free,
    state,
  );
  if (supply) take(creep, supply);
};

/**
 * @description 无 CARRY 的可移动工人：前往最近的活跃 source 采集，能量按引擎规则落地供搬运者拾取。
 * @param creep 有有效 WORK、MOVE 而没有 CARRY 的 creep。
 * @param info 所在房间的事实快照。
 * @param state 本 tick 状态。
 * @returns 无返回值。
 */
const mine = (creep: Creep, info: RoomInfo, state: TickState): void => {
  const source = creep.pos.findClosestByRange(info.sources);
  if (!source) return;
  if (creep.pos.isNearTo(source)) creep.harvest(source);
  else step(creep, source.pos, 1, info, state);
};

/**
 * @description 从供给取能：掉落资源用 pickup，其余用 withdraw。
 * @param creep 执行者，已紧挨供给。
 * @param supply 供给对象。
 * @returns 无返回值。
 */
const take = (creep: Creep, supply: Supply): void => {
  if ("amount" in supply) creep.pickup(supply);
  else creep.withdraw(supply, RESOURCE_ENERGY);
};

/**
 * @description 空载 creep 取能：选最近的有剩余供给；没有供给且能采集时，前往最近的活跃 source 采集。
 * 刚提交的取能不算已拿到能量，本 tick 不再据此提交其他动作。
 * @param creep 空载的移动 creep。
 * @param info 所在房间的事实快照。
 * @param state 本 tick 状态。
 * @param canMine 是否允许采集 source。
 * @returns 无返回值。
 */
const acquire = (
  creep: Creep,
  info: RoomInfo,
  state: TickState,
  canMine: boolean,
): void => {
  const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
  const supply = pick(creep, info.supply, supplyEnergy, free, state);
  if (supply) {
    if (creep.pos.isNearTo(supply)) take(creep, supply);
    else if (!step(creep, supply.pos, 1, info, state))
      unpick(state, supply.id, free);
    return;
  }
  if (canMine) mine(creep, info, state);
};

/**
 * @description 携能 creep 补能：按优先级分组，在第一个仍有空位的组中选最近的目标并预留其空余容量。
 * @param creep 携带能量的移动 creep。
 * @param info 所在房间的事实快照。
 * @param state 本 tick 状态。
 * @returns 找到目标并提交了转移或移动时为 true，没有补能目标时为 false。
 */
const deliver = (creep: Creep, info: RoomInfo, state: TickState): boolean => {
  const amount = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  for (const group of info.fill) {
    const target = pick(creep, group, fillFree, amount, state);
    if (!target) continue;
    if (creep.pos.isNearTo(target)) creep.transfer(target, RESOURCE_ENERGY);
    else if (!step(creep, target.pos, 1, info, state))
      unpick(state, target.id, amount);
    return true;
  }
  return false;
};

/**
 * @description 升级控制器，不在范围内时向其移动。
 * @param creep 携带能量、有有效 WORK 的移动 creep。
 * @param info 所在房间的事实快照。
 * @param state 本 tick 状态。
 * @returns 无返回值。
 */
const upgrade = (creep: Creep, info: RoomInfo, state: TickState): void => {
  if (creep.pos.inRangeTo(info.controller, 3))
    creep.upgradeController(info.controller);
  else step(creep, info.controller.pos, 3, info, state);
};

/**
 * @description 构建房间的成本矩阵：道路为 1；container 与己方或公共 rampart 可通过；其余建筑，以及 source、mineral、
 * controller 与己方阻挡类工地为 255。每个房间每 tick 至多构建一次。
 * @param info 房间的事实快照。
 * @param state 本 tick 状态，缓存已构建的矩阵。
 * @returns 该房间的成本矩阵。
 */
const matrixFor = (info: RoomInfo, state: TickState): CostMatrix => {
  const cached = state.matrices.get(info.room.name);
  if (cached) return cached;
  const matrix = new PathFinder.CostMatrix();
  for (const s of info.structures) {
    if (s.structureType === STRUCTURE_ROAD) matrix.set(s.pos.x, s.pos.y, 1);
    else if (s.structureType === STRUCTURE_CONTAINER) continue;
    else if (
      s.structureType === STRUCTURE_RAMPART &&
      ((s as StructureRampart).my || (s as StructureRampart).isPublic)
    )
      continue;
    else matrix.set(s.pos.x, s.pos.y, 255);
  }
  for (const p of info.obstacles) matrix.set(p.x, p.y, 255);
  state.matrices.set(info.room.name, matrix);
  return matrix;
};

/**
 * @description 在本房间内寻路并走出第一步；疲劳、本 tick 寻路次数用完或找不到路径时原地不动。
 * 疲劳的 creep 本 tick 的 move 必然返回 ERR_TIRED（engine creeps.js），寻路结果作废，所以先于寻路返回，不消耗名额（审计 S-20）。
 * @param creep 执行者。
 * @param target 目标位置。
 * @param range 到达范围。
 * @param info 所在房间的事实快照，用于构建成本矩阵。
 * @param state 本 tick 状态，累计寻路次数。
 * @returns 提交了移动时为 true；调用方据此决定是否撤回预留。
 */
const step = (
  creep: Creep,
  target: RoomPosition,
  range: number,
  info: RoomInfo,
  state: TickState,
): boolean => {
  if (creep.fatigue > 0 || state.paths >= FB_PATH_LIMIT) return false;
  state.paths += 1;
  const result = PathFinder.search(
    creep.pos,
    { pos: target, range },
    {
      maxRooms: 1,
      maxOps: FB_PATH_OPS,
      plainCost: 2,
      swampCost: 10,
      /**
       * @description 寻路只在本房进行：本房返回本 tick 缓存的成本矩阵，其他房间返回 false 表示不可通行。
       * @param name 房间名。
       * @returns 成本矩阵，或 false。
       */
      roomCallback: (name) =>
        name === info.room.name ? matrixFor(info, state) : false,
    },
  );
  const next = result.path[0];
  if (!next) return false;
  creep.move(creep.pos.getDirectionTo(next));
  return true;
};
