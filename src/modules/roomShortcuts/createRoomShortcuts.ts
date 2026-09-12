/**
 * 文件摘要：按房间缓存建筑、Source 与 Mineral 的 id，并提供强类型快捷查询。
 *
 * 模块位置：src/modules/roomShortcuts 的实现文件（同目录 types.ts 提供类型契约）。
 * app 层 roomShortcutsPlugin 在 setup 中调用本工厂，并把返回值发布为服务
 * 'roomShortcuts'，因此这里是“查询基础设施”，不做任何业务决策。
 *
 * 主要输入 / 输出：输入是 RoomShortcutsOpt（模块上下文 + forceReInit/cacheLeaseTicks）；
 * 输出是一个查询对象，共 22 个以房间名为参数的 getter：13 个数组型
 * （spawn/extension/rampart/road/wall/keeperLair/portal/link/lab/container/tower/
 * powerBank/source）与 9 个单值型（observer/powerSpawn/extractor/nuker/factory/
 * storage/terminal/invaderCore/mineral）。集合查询无结果返回 `[]`，单对象查询无结果返回
 * `undefined`；房间尚未建设某类建筑属于正常状态，不记录警告。
 *
 * 状态与副作用：模块使用闭包保存按房间分组的堆内缓存，以一次 FIND 查询换取租约期间的低成本
 * `Game.getObjectById` 查询。全局建筑建成和毁坏事件用于增量维护缓存；固定 tick
 * 租约及视野丢失时的主动失效负责兜底，避免事件遗漏让陈旧数据长期存活。
 * 三个状态容器都只存在于当前 global 实例，不写入 Memory/RawMemory：global reset 或插件
 * 重新 setup 后从空状态按首次查询重建（见 docs/design/modules/roomShortcuts.md）。
 *
 * 已接受的一致性风险：若房间失去视野期间没有任何 getter 调用，模块不会立即发现这次中断，
 * 旧缓存会继续使用到租约到期。期间新增的建筑可能延迟出现，已失效的 id 会在查询时被过滤，
 * 因此结果不会指向不存在的对象，只会暂时偏旧；租约提供最终一致。
 */
import {
  RoomShortcutsOpt,
  ShortcutsCache,
  CachedMap,
  STRUCTURE_KEY,
  ALL_CACHED_KEY,
  CachedObject,
} from './types';

/**
 * 创建房间索引查询服务：闭包持有各房间缓存与初始化 tick，订阅一次建筑事件做增量维护。
 * 返回值是查询接口而非单例本体，调用方（app 层插件）负责在 setup 中注册为服务并在
 * 停用时释放；global reset 后缓存从空开始，由首次查询按租约重建。
 */
export const createRoomShortcuts = (opt: RoomShortcutsOpt) => {
  /** Runtime 提供共享总线；env 提供可替换的 Game 查询和模块日志。 */
  const { bus } = opt;
  const { getGame, getRoom, getObjectById, log } = opt.env;
  const { forceReInit = false, cacheLeaseTicks = 5000 } = opt;
  /**
   * 租约长度归一化：默认 5000 tick，表示“缓存最多陈旧这么久”。
   * NaN/Infinity/0/负数/小数都会破坏 `time - initializedAt >= lease` 的比较语义
   * （比较恒为 false 将永不刷新，反之则每 tick 重扫），因此统一收敛为不小于 1 的整数。
   */
  const normalizedCacheLeaseTicks = Number.isFinite(cacheLeaseTicks)
    ? Math.max(1, Math.floor(cacheLeaseTicks))
    : 5000;

  /**
   * 三个对象以 roomName 使用同一索引：初始化标记控制快速判断，时间戳用于
   * 计算租约，shortcutsCache 保存实际 id 数组。它们都只存在于当前全局实例。
   *
   * 生命周期：随工厂闭包存活（即一个 global 生命周期或一次插件 setup）；
   * 只保存 id 而不是 RoomObject，避免跨 tick 持有会失效的游戏对象引用，
   * 解析对象时统一走 getObjectById。
   */
  const initedRooms: { [roomName: string]: boolean } = {};
  const initializedAt: { [roomName: string]: number } = {};
  const shortcutsCache: ShortcutsCache = {};

  const invalidate = (roomName: string): void => {
    /**
     * 删除同一房间的全部关联状态，使下一次 getter 必须执行完整初始化。
     *
     * 三个容器必须一起删除：只删缓存会留下 initializedAt 的旧时间戳，
     * 让租约判断基于过期起点。先判断“本来就没有缓存”可避免无意义日志。
     */
    if (!initedRooms[roomName] && !shortcutsCache[roomName]) return;

    delete shortcutsCache[roomName];
    delete initedRooms[roomName];
    delete initializedAt[roomName];
    log.info(`Room ${roomName} shortcuts invalidated.`);
  };

  /**
   * 处理 structure:destroyed 事件，把被摧毁的建筑从对应类型数组中摘除。
   *
   * 事件只带原建筑 id 与 Ruin id，因此这里用双 id 协议校验：先用 `ruinId` 取回 Ruin，
   * 再用 `structureId` 确认它确实是该 Ruin 的来源建筑。任何一步无法验证（Ruin 已消失、
   * 视野丢失、id 不匹配、事件本身矛盾）都会整房失效而不是猜测性删除——重扫的成本是确定的，
   * 误删则会静默污染缓存，因此选择 fail-safe 策略。
   *
   * 已知边界：核弹摧毁不会生成 Ruin（并会清掉已有 Ruin），无法组成双 id 协议；
   * 这类删除只能等租约到期或其它失效路径兜底，修复需要引入核弹消息类型（见设计文档）。
   */
  const removeDestroyedStructure = (
    roomName: string,
    structureId: Id<Structure>,
    ruinId: Id<Ruin>
  ): void => {
    /**
     * 双 id 协议用 `ruinId` 找到废墟中的原建筑类型，再用 `structureId` 校验
     * 消息指向同一对象。任何无法验证的情况都整房失效，防止误删其他缓存项。
     */
    if (!initedRooms[roomName]) return;

    const ruin = getObjectById(ruinId);
    if (!ruin) {
      log.warn(
        `Ruin ${ruinId} not found; invalidating shortcuts for room ${roomName}.`
      );
      invalidate(roomName);
      return;
    }

    if (ruin.pos.roomName !== roomName) {
      log.warn(
        `Ruin ${ruinId} belongs to room ${ruin.pos.roomName}, not subscribed room ${roomName}; invalidating shortcuts.`
      );
      invalidate(roomName);
      return;
    }

    if (ruin.structure.id !== structureId) {
      log.warn(
        `Destroyed structure ${structureId} does not match ruin ${ruinId} (${ruin.structure.id}) in room ${roomName}; invalidating shortcuts.`
      );
      invalidate(roomName);
      return;
    }

    /**
     * 校验通过后可以安全地做局部删除。structureType 来自 Ruin 携带的原建筑信息，
     * 因此断言为缓存键；`?.` 与 `!cachedIds` 兜住“该房间尚未缓存过这类建筑”。
     * 断言的另一层原因：索引结果在 Partial mapped type 下是多种 id 数组的联合，
     * 只有收敛为 Id<Structure>[] 才能调用 indexOf/splice。
     */
    const structureType = ruin.structure.structureType as STRUCTURE_KEY;
    const cachedIds = shortcutsCache[roomName]?.[structureType] as
      Id<Structure>[] | undefined;
    if (!cachedIds) return;

    /**
     * 原地删除能保留该类型数组引用，避免为一次事件复制整个数组。
     * 找不到元素说明缓存本就不同步（例如租约期内的其它遗漏），此时不做额外处理，
     * 租约到期或下一次协议异常会触发整房重建。
     */
    const index = cachedIds.indexOf(structureId);
    if (index !== -1) {
      cachedIds.splice(index, 1);
      log.info(
        `Destroyed structure ${structureId} removed from shortcuts: ${roomName} ${structureType}.`
      );
    }
  };

  /**
   * 扫描有视野房间并重建全部快捷索引。
   *
   * `room.find` 是本模块的主要 CPU 成本，因此只在首次查询、强制刷新或租约
   * 到期时执行。建筑先由 lodash 按 structureType 分组，资源节点随后合并到
   * 同一索引，最终只缓存 id，避免跨 tick 长期持有失效的 RoomObject 引用。
   *
   * 失败路径：房间当前无视野时只记录错误并直接返回，调用方稍后会看到缓存缺失，
   * 从而返回与查询形态一致的空结果，而不是抛错中断上层行为。
   */
  const init = (roomName: string, force: boolean = forceReInit) => {
    const room = getRoom(roomName);
    if (!room) {
      log.error(`Room ${roomName} not found, cannot initialize shortcuts.`);
      return;
    }

    /**
     * force=false 时已初始化即直接复用（缓存未过期）；force=true 时重新扫描，
     * 用日志区分这两种情况，便于诊断测试中的强制刷新。
     */
    if (initedRooms[roomName] && !force) {
      log.info(`Room ${roomName} already initialized, skipping.`);
      return;
    } else if (initedRooms[roomName] && force) {
      log.info(
        `Room ${roomName} already initialized, but force re-initializing.`
      );
    }

    /** 先写入局部对象，全部构建完成后再一次性发布到 shortcutsCache。 */
    const cache: Partial<CachedMap> = {};

    /**
     * 将房间建筑按类型分组，并把 Source、Mineral 作为虚拟缓存类别合并。
     *
     * lodash 的 groupBy 结果以字符串为键，类型上无法证明恰好是 STRUCTURE_KEY，
     * 因此断言为 Partial<Record<STRUCTURE_KEY, Structure[]>>；展开运算把分组结果与
     * 两类资源节点合并成一个待缓存映射。controller 不会出现在 FIND_STRUCTURES 中，
     * 所以它总是缺键（见 types.ts 的说明）。
     */
    const grouped = {
      ...(_.groupBy(room.find(FIND_STRUCTURES), 'structureType') as Partial<
        Record<STRUCTURE_KEY, Structure[]>
      >),
      source: room.find(FIND_SOURCES),
      mineral: room.find(FIND_MINERALS),
    };

    /**
     * 泛型辅助函数保持 key 与对应 id 数组类型的关联。
     * 若直接写 `cache[key] = ids`，索引访问会退化为联合类型而无法赋值；
     * 用 K 把键与值绑定后，调用点仍能获得精确检查。
     */
    const setCache = <K extends keyof CachedMap>(key: K, ids: CachedMap[K]) => {
      cache[key] = ids;
    };

    /**
     * 只保留 id：一次遍历把每类对象映射为 id 数组。`!` 断言排除 groupBy 结果中
     * 可能为 undefined 的键（Object.keys 只会枚举实际存在的键）；末尾的断言把
     * 泛型键的 id 数组呈现给 setCache——键与值的对应关系由上面的 grouped 结构保证。
     */
    (Object.keys(grouped) as (keyof typeof grouped)[]).forEach((key) => {
      setCache(key, grouped[key]!.map((s) => s.id) as CachedMap[typeof key]);
    });

    /**
     * 完成全部映射后再整体发布缓存，避免查询方看到半初始化状态。
     * 三个容器同时写入：initializedAt 记录本次扫描的 tick，作为租约起点。
     */
    shortcutsCache[roomName] = cache;
    initedRooms[roomName] = true;
    initializedAt[roomName] = getGame().time;
    log.info(`Room ${roomName} shortcuts initialized.`);
  };

  /**
   * 响应建筑建造完成事件，对已经初始化的房间执行增量追加。
   *
   * 未初始化房间无需更新，因为它首次查询时会扫描当前真实状态；对象缺失、
   * 房间不匹配等协议异常会触发整房失效，等待后续查询自愈。
   *
   * 成本取舍：增量路径需要一次 getObjectById 取出对象以确认类型与房间，换来的是
   * 避免整个房间重扫；这条路径每个建成事件只发生一次，远低于 FIND 的成本。
   */
  const updateStructure = (roomName: string, id: Id<Structure>) => {
    if (!initedRooms[roomName]) {
      log.info(`Room ${roomName} not initialized, cannot update shortcuts.`);
      return;
    }

    const obj = getObjectById(id);
    if (!obj) {
      log.error(`Object with id ${id} not found, cannot update shortcuts.`);
      invalidate(roomName);
      return;
    }

    if (obj.pos.roomName !== roomName) {
      log.warn(
        `Built structure ${id} belongs to room ${obj.pos.roomName}, not event room ${roomName}; invalidating shortcuts.`
      );
      invalidate(roomName);
      return;
    }

    /**
     * 首次出现该类别时补一个空数组，保证缓存结构与 init 产出的形态一致
     * （键存在 + 值为数组），避免使用方在两种“空”之间做区分。
     * `as any` 断言用于绕开 Partial mapped type 下多类型 id 数组联合的
     * includes/push 参数约束；键与数组类型的对应关系仍由上方校验保证。
     */
    const structureType = obj.structureType as STRUCTURE_KEY;
    if (shortcutsCache[roomName][structureType] === undefined) {
      shortcutsCache[roomName][structureType] = [];
    }

    /** 事件可能重复投递，入队前先查重，避免同一建筑在数组中出现多次。 */
    if (shortcutsCache[roomName][structureType].includes(id as any)) {
      log.warn(`Structure with id ${id} already in shortcuts, skipping.`);
      return;
    }

    shortcutsCache[roomName][structureType].push(id as any);
    log.info(
      `Structure with id ${id} added to shortcuts: ${roomName} ${structureType}.`
    );
  };

  /**
   * 所有公共 getter 的统一读取路径。
   *
   * 无视野时无法验证缓存，立即失效并返回稳定空值；有视野时按初始化状态、
   * `forceReInit` 与 tick 租约决定是否重扫。单对象查询以 undefined 表示无结果，
   * 多对象查询以空数组表示无结果，使调用方无需额外判断 null。
   *
   * 空结果契约（与 docs/design/modules/roomShortcuts.md 一致）：房间不存在该类别建筑不是错误，
   * 只有“无视野”“初始化失败”等异常路径才记录错误日志，其余空结果静默返回。
   * 泛型 K 让返回值随传入键收窄；isSingle 只影响返回形态，不改变缓存内容。
   */
  const createGetter = <K extends ALL_CACHED_KEY>(
    key: K,
    roomName: string,
    isSingle?: boolean
  ): CachedObject<K> | CachedObject<K>[] | undefined => {
    /** 无视野时缓存无法验证：立即失效，并按查询形态返回空值。 */
    if (!getRoom(roomName)) {
      log.error(
        `no visual on Room ${roomName}, structure shortcuts unavailable.`
      );
      invalidate(roomName);
      return isSingle ? undefined : [];
    }
    /**
     * 租约判断：以完整初始化时刻为起点，差值与 normalizedCacheLeaseTicks 比较。
     * forceReInit 时短路为 false，让下面的分支统一走“强制刷新”路径。
     * initializedAt 仅对已初始化房间有效，因此先判断 initedRooms。
     */
    const leaseExpired =
      !forceReInit &&
      initedRooms[roomName] &&
      getGame().time - initializedAt[roomName] >= normalizedCacheLeaseTicks;

    /**
     * 缓存缺失、显式强制刷新或租约到期都会进入同一初始化路径。
     * 日志按三种原因区分，便于在控制台确认是冷启动、诊断刷新还是租约兜底。
     */
    if (!initedRooms[roomName] || forceReInit || leaseExpired) {
      log.info(
        `Room ${roomName} cache ${forceReInit ? 'refresh requested' : leaseExpired ? 'lease expired' : 'missed'}, initializing now.`
      );
      init(roomName, forceReInit || leaseExpired);
    }

    /** 初始化失败时缓存可能仍不存在，此处返回与查询形态一致的空结果。 */
    const cacheMap = shortcutsCache[roomName];
    if (!cacheMap) {
      log.error(`an error occurred, room ${roomName} has no cacheMap.`);
      return isSingle ? undefined : [];
    }

    /** 键缺失（该房间没有这类建筑）与空数组都按“无结果”处理，两种形态语义相同。 */
    if (!cacheMap[key] || cacheMap[key].length === 0) {
      return isSingle ? undefined : [];
    }
    /**
     * 单对象类别读取首个 id；数组类别逐个解析并滤掉已失效对象。
     * 类型谓词让 filter 后的数组从 `(CachedObject | null)[]` 收窄为对象数组。
     *
     * `as CachedObject<K> | null` 断言的理由：Game.getObjectById 的泛型无法从
     * “id 数组的联合”反推出与键 K 对应的对象类型；单值分支额外用 `?? undefined`
     * 把 null 归一化为 undefined，与空结果契约保持一致。
     * 过滤只兜住“缓存里有两三个已消失的 id”这一常见漂移，租约到期后仍会整房重扫。
     */
    if (isSingle) {
      return (
        (getObjectById(cacheMap[key][0]) as CachedObject<K> | null) ?? undefined
      );
    }

    return cacheMap[key]
      .map((id) => getObjectById(id) as CachedObject<K> | null)
      .filter((object): object is CachedObject<K> => object !== null);
  };

  /**
   * 模块是全局缓存管理器，因此仅在创建时各订阅一次全局建筑事件；事件中的
   * roomName 决定具体更新哪个房间，避免为每个已访问房间重复注册监听器。
   *
   * 订阅时机与生命周期：订阅发生在工厂调用期（插件 setup），scope 'global' 保证
   * 每条消息只投递一次；订阅随插件上下文登记，停用或 global reset 后由框架清理，
   * 重新 setup 时随闭包缓存一起重建。回调只做缓存维护，不产生跨 tick 状态。
   */
  bus.subscribe(
    { scope: 'global' },
    'structure:built',
    'roomShortcuts',
    (data) => updateStructure(data.roomName, data.structureId)
  );
  bus.subscribe(
    { scope: 'global' },
    'structure:destroyed',
    'roomShortcuts',
    (data) =>
      removeDestroyedStructure(data.roomName, data.structureId, data.ruinId)
  );

  /**
   * 公共快捷方法只负责固定缓存 key 和单值/数组语义，生命周期与校验逻辑全部
   * 收敛在 createGetter 中。类型断言把通用泛型返回值呈现为 Screeps 具体对象。
   *
   * 每个 getter 都是薄封装：常量键（或 'source'/'mineral'）在编译期确定，因此
   * 调用方拿到的是具体结构数组类型而不是联合类型；单值类别显式传 isSingle=true。
   * 这些函数不增加缓存维度，同一房间同一类别的多次调用共享同一份 id 数组。
   */
  return {
    getSpawn: (roomName: string) =>
      createGetter(STRUCTURE_SPAWN, roomName) as StructureSpawn[],
    getExtension: (roomName: string) =>
      createGetter(STRUCTURE_EXTENSION, roomName) as StructureExtension[],
    getRampart: (roomName: string) =>
      createGetter(STRUCTURE_RAMPART, roomName) as StructureRampart[],
    getRoad: (roomName: string) =>
      createGetter(STRUCTURE_ROAD, roomName) as StructureRoad[],
    getWall: (roomName: string) =>
      createGetter(STRUCTURE_WALL, roomName) as StructureWall[],
    getKeeperLair: (roomName: string) =>
      createGetter(STRUCTURE_KEEPER_LAIR, roomName) as StructureKeeperLair[],
    getPortal: (roomName: string) =>
      createGetter(STRUCTURE_PORTAL, roomName) as StructurePortal[],
    getLink: (roomName: string) =>
      createGetter(STRUCTURE_LINK, roomName) as StructureLink[],
    getLab: (roomName: string) =>
      createGetter(STRUCTURE_LAB, roomName) as StructureLab[],
    getContainer: (roomName: string) =>
      createGetter(STRUCTURE_CONTAINER, roomName) as StructureContainer[],
    getTower: (roomName: string) =>
      createGetter(STRUCTURE_TOWER, roomName) as StructureTower[],
    getPowerBank: (roomName: string) =>
      createGetter(STRUCTURE_POWER_BANK, roomName) as StructurePowerBank[],
    getObserver: (roomName: string) =>
      createGetter(STRUCTURE_OBSERVER, roomName, true) as
        StructureObserver | undefined,
    getPowerSpawn: (roomName: string) =>
      createGetter(STRUCTURE_POWER_SPAWN, roomName, true) as
        StructurePowerSpawn | undefined,
    getExtractor: (roomName: string) =>
      createGetter(STRUCTURE_EXTRACTOR, roomName, true) as
        StructureExtractor | undefined,
    getNuker: (roomName: string) =>
      createGetter(STRUCTURE_NUKER, roomName, true) as
        StructureNuker | undefined,
    getFactory: (roomName: string) =>
      createGetter(STRUCTURE_FACTORY, roomName, true) as
        StructureFactory | undefined,
    getStorage: (roomName: string) =>
      createGetter(STRUCTURE_STORAGE, roomName, true) as
        StructureStorage | undefined,
    getTerminal: (roomName: string) =>
      createGetter(STRUCTURE_TERMINAL, roomName, true) as
        StructureTerminal | undefined,
    getInVaderCore: (roomName: string) =>
      createGetter(STRUCTURE_INVADER_CORE, roomName, true) as
        StructureInvaderCore | undefined,
    getSource: (roomName: string) =>
      createGetter('source', roomName) as Source[],
    getMineral: (roomName: string) =>
      createGetter('mineral', roomName, true) as Mineral | undefined,
  };
};
