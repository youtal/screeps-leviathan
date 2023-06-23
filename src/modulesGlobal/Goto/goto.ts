import {
  PATH_CACHE,
  CREEP_PATH_CACHE,
  moveOption,
  PATH_CACHE_UNIT,
  CREEP_PATH_CACHE_UNIT,
} from "./types";
import { Obstacles_Structuretype } from "@/constants";
import { getCrossRule, getCrossDirectionRule } from "./crossRules";
import { log, Color, getNearPos, dirToPos } from "@/utils";
import { Role, RoleOperator } from "@/role/types";

const debugLog = (debug: boolean, content: string) => {
  if (debug) log(content, "[Log goto]", Color.Green);
};

const debugError = (debug: boolean, content: string) => {
  if (debug) log(content, "[Error goto]", Color.Red);
};

const debugWarn = (debug: boolean, content: string) => {
  if (debug) log(content, "[Warn goto]", Color.Yellow);
};

const debugSuccess = (debug: boolean, content: string) => {
  if (debug) log(content, "[Success goto]", Color.Green);
};

//swap、plain的cost对照表，键为是否忽略swap或road
const terrainCost = {
  "00": [10, 2],
  "10": [2, 2],
  "01": [5, 1],
  "11": [1, 1],
};
//CostMatrix建立时间超过这个数字的CostMatrix视为过期，未启用。
const COST_MATRIX_UPDATE_INTERVAL = 100000;
//路径有效期
const PATH_INTERVAL = 1500000;
//核心半径，在房间核心到这个半径内的区域，creep会无脑对穿，防止交通拥挤
const CORE_RADIUS = 3;
//路径缓存
let pathCache: PATH_CACHE = {};
//按照creep正在使用的路径缓存
let creepPathCache: CREEP_PATH_CACHE = {};
//CostMatrix缓存，后缀表示是否忽略沼泽和路
let costMatrixCache: Record<string, CostMatrix> = {};
//房间类型
enum roomType {
  highWay,
  my,
  default,
  armedCenter,
  infinity,
}

//配置各个房间类型在寻路活动中的权重
const roomWeight: { [tp in roomType]: number } = {
  [roomType.highWay]: 1,
  [roomType.my]: 1.5,
  [roomType.default]: 2,
  [roomType.armedCenter]: 4,
  [roomType.infinity]: Infinity,
};

/**
 *
 * @param name 待评估房间名
 * @returns 房间评估权重，数字越大优先级越低
 * @description 评估房间权重，根据房间名字判断房间类型，返回对应的权重
 */
function evalRoomWight(name: string): number {
  let rp = roomType.default;
  let room = Game.rooms[name];
  let parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(name);
  if (_.parseInt(parsed[1]) % 10 === 0 || _.parseInt(parsed[2]) % 10 === 0) {
    rp = roomType.highWay;
  } else if (room?.controller?.my) {
    rp = roomType.my;
  } else if (
    _.parseInt(parsed[1]) % 10 === (4 || 6) &&
    _.parseInt(parsed[2]) % 10 === (4 || 6)
  ) {
    rp = roomType.armedCenter;
  }

  return roomWeight[rp];
}

/**
 *
 * @param origin 起点
 * @param goal 终点
 * @param ops 使用ops中的swapSymbol，roadSymbol，range字段
 * @returns 路径在全局缓存中的key
 */
const generateRouteKey = function (
  origin: RoomPosition,
  goal: RoomPosition,
  ops: moveOption
): string {
  const { range, ignoreRoads, ignoreSwap } = ops;
  const [roadSymbol, swapSymbol] = [ignoreRoads ? 1 : 0, ignoreSwap ? 1 : 0];
  return `${origin.roomName}-${origin.x}-${origin.y}-${goal.roomName}-${goal.x}-${goal.y}-${range}-${roadSymbol}-${swapSymbol}`;
};

/**
 *
 * @param mat 初始CostMatrix，如果不传入则会自动从房间中获取
 * @param roomNme 房间名
 * @returns CostMatrix
 * 该函数会自动缓存CostMatrix，如果已经缓存过，会直接返回缓存中的CostMatrix
 * 对于使用PathFinder.search的寻路，使用该函数获取CostMatrix之前应当提前判断该房间是否应当被忽略
 */
const getCostMatrix = function (
  roomName: string,
  ops: moveOption,
  mat?: CostMatrix
): CostMatrix {
  let startTime = 0;
  if (ops.debug) startTime = Game.cpu.getUsed();
  if (!mat) mat = new PathFinder.CostMatrix();

  //生成costMatrix缓存key
  const swapSymbol = ops.ignoreSwap ? 1 : 0;
  const roadSymbol = ops.ignoreRoads ? 1 : 0;
  const costMatrixKey = `${roomName}${swapSymbol}${roadSymbol}`;

  //尝试读取缓存中的CostMatrix
  if (costMatrixCache[costMatrixKey]) {
    debugSuccess(
      ops.debug,
      `getCostMatrix: 读取缓存中的CostMatrix,key:${costMatrixKey}`
    );
    return costMatrixCache[costMatrixKey].clone();
  }

  //根据配置确定swap和plain的cost
  const terrainCostKey = `${swapSymbol}${roadSymbol}`;
  let costMap = {
    0: terrainCost[terrainCostKey][1],
    TERRAIN_MASK_SWAMP: terrainCost[terrainCostKey][0],
    TERRAIN_MASK_WALL: 0xff,
  };

  //根据房间地形配置costMap
  const terrain = Game.map.getRoomTerrain(roomName);
  for (let x = 0; x < 50; x++)
    for (let y = 0; y < 50; y++) {
      mat.set(x, y, costMap[terrain.get(x, y)]);
    }

  //房间没视野，返回仅根据地形配置了cost的costMatrix，并缓存
  const room = Game.rooms[roomName];
  if (!room) {
    costMatrixCache[costMatrixKey] = mat;
    debugWarn(
      ops.debug,
      `getCostMatrix: 房间没视野，返回仅根据地形配置了cost的costMatrix`
    );
    return mat;
  }

  //首先将source周围的cost调高，目的是让creep倾向规避source周围，避免影响harvester工作
  //此步放在按照地形权重配置之后，覆盖地形权重
  //const sources = room.find(FIND_SOURCES);
  const sources = room.source;
  sources.forEach((s) => {
    let nearPos = getNearPos(s.pos);
    nearPos.forEach((pos) => {
      let { x, y } = pos;
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL)
        mat.set(x, y, costMap.TERRAIN_MASK_SWAMP * 5);
    });
  });

  //将Mineral周围的cost调高，目的是让creep倾向规避Mineral周围，避免影响miner工作
  //此步放在按照地形权重配置之后，覆盖地形权重
  //const mineral = room.find(FIND_MINERALS)[0];
  const mineral = room.mineral;
  if (mineral) {
    let nearPos = getNearPos(mineral.pos);
    nearPos.forEach((pos) => {
      let { x, y } = pos;
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL)
        mat.set(x, y, costMap.TERRAIN_MASK_SWAMP * 5);
    });
  }

  debugLog(
    ops.debug,
    `getCostMatrix: 完成CostMatrix资源点配置,key:${costMatrixKey}，耗时:${
      Game.cpu.getUsed() - startTime
    }`
  );

  //将房间核心区设为禁行区
  //TODO：房间对象访问缓存实现后，应换为房间对象缓存访问center
  if (room.memory.center) {
    let center = new RoomPosition(
      room.memory.center[0],
      room.memory.center[1],
      roomName
    );
    if (center) {
      let forbiddenZone = getNearPos(center);
      forbiddenZone.forEach((pos) => {
        let { x, y } = pos;
        mat.set(x, y, 0xff);
      });
      debugLog(
        ops.debug,
        `getCostMatrix: 完成CostMatrix核心区配置,key:${costMatrixKey}，耗时:${
          Game.cpu.getUsed() - startTime
        }`
      );
    }
  }

  const addCost = (item: Structure | ConstructionSite) => {
    // 更倾向走道路
    if (item.structureType === STRUCTURE_ROAD) {
      // 造好的路可以走
      if (item instanceof Structure) mat.set(item.pos.x, item.pos.y, 1);
      // 路的工地保持原有 cost
      else return;
    }
    // 非我rampart即视为不可通过，无论是否为public状态，防止被放风筝
    else if (item instanceof StructureRampart) {
      if (!item.my) mat.set(item.pos.x, item.pos.y, 0xff);
      else return;
    }
    //挡路建筑设为255
    else if (Obstacles_Structuretype.includes(item.structureType)) {
      mat.set(item.pos.x, item.pos.y, 0xff);
    }
  };

  //按照建筑配置
  const structures = room.find(FIND_STRUCTURES);
  const sites = room.find(FIND_CONSTRUCTION_SITES);
  structures.forEach(addCost);
  sites.forEach(addCost);
  debugLog(
    ops.debug,
    `getCostMatrix: 完成CostMatrix建筑配置,耗时:${
      Game.cpu.getUsed() - startTime
    }`
  );

  //配置设置了不可对穿的creep
  if (!ops.ignoreCreeps) {
    //躲避不可对穿的creep
    room.find(FIND_CREEPS).forEach((toCross) => {
      if (
        ops.disableCross ||
        !toCross.my ||
        !getCrossRule(toCross.memory.role)(toCross)
      ) {
        mat.set(toCross.pos.x, toCross.pos.y, 0xff);
      }
    });

    //躲避非己方pc
    room.find(FIND_POWER_CREEPS).forEach((pc) => {
      if (ops.disableCross || !pc.my || !getCrossRule(Role.Operator)(pc)) {
        mat.set(pc.pos.x, pc.pos.y, 0xff);
      }
    });
    debugLog(
      ops.debug,
      `getCostMatrix: 完成CostMatrix creep配置,耗时:${
        Game.cpu.getUsed() - startTime
      }`
    );
  }

  costMatrixCache[costMatrixKey] = mat;
  debugSuccess(
    ops.debug,
    `getCostMatrix: 完成CostMatrix配置,耗时:${Game.cpu.getUsed() - startTime}`
  );
  return mat.clone();
};

/**
 *
 * @param rawPath 使用RoomPosition.findPathTo寻路的路径
 * @param roomName 路径所在房间名
 * @param goal 路径终点
 * @param debug 是否开启debug模式
 * @returns PATH_CACHE_UNIT，用于全局缓存
 * @description 用于压缩单房间路径每个路径节点使用一个数字表示，数字的低4位表示移动方向，5-10位表示x坐标，11-16位表示y坐标
 */
const serializeSinglePath = function (
  rawPath: PathStep[],
  roomName: string,
  goal: RoomPosition,
  debug = false
): PATH_CACHE_UNIT {
  let startTime = 0;
  if (debug) startTime = Game.cpu.getUsed();
  let path = new Array<number>(rawPath.length - 1).fill(0);
  for (let i = 0; i < rawPath.length - 1; i++) {
    const { x, y } = rawPath[i];
    const { direction } = rawPath[i + 1];
    path[i] = (direction << 0) | (x << 4) | (y << 10);
  }
  const end = new RoomPosition(
    rawPath[rawPath.length - 1].x,
    rawPath[rawPath.length - 1].y,
    roomName
  );
  debugSuccess(
    debug,
    `serializeSinglePath: ${path},耗时:${Game.cpu.getUsed() - startTime}`
  );
  return {
    path,
    roomNames: [roomName],
    isSingelRoom: true,
    incomplete: end.isEqualTo(goal),
    generateTime: Game.time,
    used: 1,
    end,
  };
};

/**
 *
 * @param creep 使用该路径的creep
 * @param goal 终点，仅支持RoomPosition
 * @param ops 移动参数
 * @returns CREEP_PATH_CACHE，包含路径和路径的key
 * @description 用于房间内寻路，使用RoomPosition.findPathTo寻路
 */
const findPathInRoom = function (
  creep: Creep | PowerCreep,
  goal: RoomPosition,
  ops: moveOption
): CREEP_PATH_CACHE_UNIT {
  let startTime = 0;
  let routeKey = generateRouteKey(creep.pos, goal, ops);
  if (ops.debug) startTime = Game.cpu.getUsed();
  const rwaPath = creep.pos.findPathTo(goal, ops);
  //将起点压入路径
  rwaPath.unshift({
    x: creep.pos.x,
    y: creep.pos.y,
    dx: 0,
    dy: 0,
    direction: TOP,
  });
  const path = serializeSinglePath(rwaPath, creep.room.name, goal, ops.debug);
  //将结果缓存到全局缓存中
  pathCache[routeKey] = path;
  debugLog(
    ops.debug,
    `findPathInRoom: 完成寻路,耗时:${Game.cpu.getUsed() - startTime}`
  );
  return _.defaults(path, { key: routeKey, idx: 0 });
};

/**
 *
 * @param rawPath 使用PathFinder.search寻路的路径
 * @returns PATH_CACHE_UNIT，用于全局缓存
 * 每个路径节点使用一个数字表示，数字的低4位表示移动方向，5-10位表示x坐标，11-16位表示y坐标，17-20位表示房间索引
 */
const serializeMultiPath = function (
  rawPath: PathFinderPath,
  goal: RoomPosition,
  debug: boolean = false
): PATH_CACHE_UNIT {
  let startTime = 0;
  if (debug) startTime = Game.cpu.getUsed();
  const { path: posArr, incomplete } = rawPath;
  let path = new Array<number>(posArr.length - 1).fill(0);
  let roomNames = new Array<string>(16);
  let roomName = posArr[0].roomName;
  let roomIdx = 0;
  roomNames[roomIdx] = roomName;
  for (let i = 0; i < posArr.length - 1; i++) {
    //如果进入了新房间，更新房间名和房间索引,并跳过本次循环,因为新房间的第一个节点不需要压入路径
    if (posArr[i + 1].roomName !== roomName) {
      roomName = posArr[i + 1].roomName;
      roomIdx++;
      roomNames[roomIdx] = roomName;
      continue;
    }
    const { x, y } = posArr[i];
    const direction = posArr[i].getDirectionTo(posArr[i + 1]);
    path[i] = (direction << 0) | (x << 4) | (y << 10) | (roomIdx << 16);
  }
  path = path.filter((item) => item);
  roomNames = roomNames.filter((item) => item);
  debugSuccess(
    debug,
    `serializeMultiPath: ${path},耗时:${Game.cpu.getUsed() - startTime}`
  );
  return {
    path,
    roomNames: roomNames.filter((item) => item),
    isSingelRoom: false,
    incomplete,
    generateTime: Game.time,
    used: 0,
    end: posArr[posArr.length - 1],
  };
};

/**
 *
 * @param creep 使用该路径的creep
 * @param goal 终点，仅支持RoomPosition
 * @param ops 移动参数
 * @returns CREEP_PATH_CACHE 包含路径和路径的key
 * 用于跨房间寻路，使用PathFinder.search寻路
 * 支持：该函数会自动将结果缓存到全局缓存中，如果已经存在相同路径，会直接返回全局缓存中的路径
 * 不支持：该函数不会将结果缓存到当前creep的缓存中，需要在调用该函数之后手动将结果缓存到creep的缓存中
 */
const findPathMultiRoom = function (
  creep: Creep | PowerCreep,
  goal: RoomPosition,
  ops: moveOption
): CREEP_PATH_CACHE_UNIT {
  let startTime = 0;
  if (ops.debug) startTime = Game.cpu.getUsed();
  const routeKey = generateRouteKey(creep.pos, goal, ops);
  //首先将途径房间计算出来
  let allowedRooms: Record<string, boolean> = {};
  allowedRooms[creep.room.name] = true;
  const passRooms = Game.map.findRoute(creep.room.name, goal.roomName, {
    routeCallback: (roomName: string, fromRoomName) => {
      //检查是否为屏蔽房间
      if (Memory.avoidRooms && Memory.avoidRooms.includes(roomName))
        return roomWeight[roomType.infinity];
      //检查是否为屏蔽入口
      if (
        Memory.avoidExits &&
        fromRoomName in Memory.avoidExits &&
        Memory.avoidExits[fromRoomName].includes(roomName)
      )
        return roomWeight[roomType.infinity];
      return evalRoomWight(roomName);
    },
  });
  if (passRooms === ERR_NO_PATH) {
    debugWarn(
      ops.debug,
      `findPathMultiRoom: creep: ${creep.name}无法到达目标房间${goal.roomName}`
    );
    return null;
  }
  passRooms.forEach((item) => (allowedRooms[item.room] = true));

  //使用PathFinder.search寻路
  const rwaPath = PathFinder.search(creep.pos, goal, {
    roomCallback(roomName): boolean | CostMatrix {
      if (!allowedRooms[roomName]) return false;
      return getCostMatrix(roomName, ops);
    },
  });
  //将起点压入路径
  if (!rwaPath.path[0].isEqualTo(creep.pos)) rwaPath.path.unshift(creep.pos);
  const path = serializeMultiPath(rwaPath, goal, ops.debug);
  //将结果缓存到全局缓存中
  pathCache[routeKey] = path;
  debugSuccess(
    ops.debug,
    `findPathMultiRoom: 完成寻路,耗时:${Game.cpu.getUsed() - startTime}`
  );
  return _.defaults(path, { routeKey, idx: 0 });
};

/**
 *
 * @param creepName creep名
 * @returns pos当前路径节点的位置，dir当前路径节点的移动方向
 */
const decodePathUnit = function (
  creepName: string,
  debug = false
): { pos: RoomPosition; dir: DirectionConstant; end: RoomPosition } {
  const curRoute = creepPathCache[creepName];
  if (!curRoute) {
    debugError(debug, `decodePathUnit: creep: ${creepName}没有缓存路径`);
    return null;
  }
  const { path, idx, roomNames, end } = curRoute;
  const pathNode = path[idx];
  const [dir, x, y, roomName] = [
    <DirectionConstant>(pathNode & 0xf),
    (pathNode >> 4) & 0x3f,
    (pathNode >> 10) & 0x3f,
    roomNames[(pathNode >> 16) & 0xf],
  ];
  return {
    pos: new RoomPosition(x, y, roomName),
    dir,
    end,
  };
};

/**
 *
 * @param creep 使用该路径的creep
 * @param goal 终点，仅支持RoomPosition
 * @param ops 移动参数
 * @returns CREEP_PATH_CACHE 包含路径和路径的key
 * @description 寻路接口，会自动判断是否跨房间，调用findPathInRoom或者findPathMultiRoom
 */
const findPath = function (
  creep: Creep | PowerCreep,
  goal: RoomPosition,
  ops: moveOption
): CREEP_PATH_CACHE_UNIT {
  _.defaults(ops, { range: 0 });
  if (creep.pos.roomName === goal.roomName) {
    debugLog(
      ops.debug,
      `findPath: creep: ${creep.name}在房间${goal.roomName}内寻路`
    );
    return findPathInRoom(creep, goal, ops);
  } else {
    debugLog(ops.debug, `findPath: creep: ${creep.name}跨房间寻路`);
    return findPathMultiRoom(creep, goal, ops);
  }
};

/**
 *
 * @param creep
 * @param goal
 * @param ops
 * @returns 路径是否错误，如果错误，返回true
 * @description 使用该函数之前应当先调用configPath，确保creep已经配置了路径
 * 该函数会根据自身creepPathCache中的路径指示的终点，与goal进行比较，如果不同，返回true
 * 若ops.range大于0，会比较goal与终点的距离，如果距离大于ops.range，返回true
 */
const verifyPath = function (
  creep: Creep | PowerCreep,
  curPos: RoomPosition,
  goal: RoomPosition,
  ops: moveOption
): boolean {
  if (!creepPathCache[creep.name]) return true;
  const { end, incomplete } = creepPathCache[creep.name];

  debugLog(
    ops.debug,
    `verifyPath: end: ${end}, goal: ${goal}, incomplete: ${incomplete}`
  );
  return !curPos.isNearTo(creep.pos) || ops.range > 0
    ? end.getRangeTo(goal) > ops.range
    : incomplete
    ? !end.isEqualTo(goal)
    : !end.isNearTo(goal);
};

/**
 *
 * @param creep 为该creep配置路径
 * @param goal creep的移动目标
 * @param ops 移动参数
 * @returns 配置路径失败为true
 * 逻辑顺序：
 * 1、该creep已经由配置好的路径，返回false
 * 2、向全局缓存中查询是否存在该路径，如果存在，将路径配置到creep中，返回false
 * 3、调用findPath，检查返回值是否有效，如果有效，将路径配置到creep中，返回false，否则返回true
 */
const configPath = function (
  creep: Creep | PowerCreep,
  goal: RoomPosition,
  ops: moveOption
): boolean {
  const routeKey = generateRouteKey(creep.pos, goal, ops);
  if (creepPathCache[creep.name]) {
    debugLog(
      ops.debug,
      `configPath: ${creep.name}路径已存在，路径：${Object.keys(
        creepPathCache[creep.name]
      )}`
    );
    return false;
  } else if (pathCache[routeKey]) {
    const targetPath: CREEP_PATH_CACHE_UNIT = _.defaults(pathCache[routeKey], {
      idx: 0,
      routeKey,
    });
    ++pathCache[routeKey].used;
    creepPathCache[creep.name] = targetPath;
    debugLog(
      ops.debug,
      `configPath: ${creep.name}从全局缓存中获取路径，路径:${Object.keys(
        targetPath
      )}`
    );
    return false;
  } else {
    debugLog(ops.debug, `configPath: ${creep.name}重新寻路`);
    const path = findPath(creep, goal, ops);
    if (path) {
      creepPathCache[creep.name] = path;
      return false;
    } else {
      debugWarn(ops.debug, `configPath: ${creep.name}寻路失败`);
      return true;
    }
  }
};

/**
 *
 * @param creep
 * @param expectPos creep当前期望应该在的位置
 * @returns 需要对穿返回true
 * 该函数会检查creep是否需要对穿，判断依据如下：
 * 1、在房间核心区域，
 * 2、与当前路径位置相邻，
 */
const checkCross = function (
  creep: Creep | PowerCreep,
  expectPos: RoomPosition,
  debug: boolean = false
): "none" | "center" | "obstruct" {
  // TODO: 房间shortcuts开发完成后，使用shortcuts来调用center
  let coreCheck = false;
  if (creep.room.memory.center) {
    const [x1, y1] = creep.room.memory.center;
    const { x, y } = creep.pos;
    if (Math.max(Math.abs(x - x1), Math.abs(y - y1)) <= CORE_RADIUS) {
      debugLog(debug, `checkCross: ${creep.name}在核心区域`);
      return "center";
    }
  }
  if (creep.pos.isNearTo(expectPos) && !creep.pos.isEqualTo(expectPos)) {
    debugLog(debug, `checkCross: ${creep.name}在期望位置附近`);
    return "obstruct";
  } else {
    return "none";
  }
};

/**
 *
 * @param creep 回应对穿请求的creep
 * @param dir 发起对穿请求的creep的移动方向
 * @returns 回应对穿请求的结果，OK表示对穿成功，ERR_BUSY拒绝对穿，ERR_INVALID_ARGS表示对穿失败
 */
const responseCross = function (
  creep: Creep | PowerCreep,
  dir: DirectionConstant,
  debug: boolean = false
): ERR_BUSY | OK {
  let response: ERR_BUSY | OK;
  debugLog(debug, `responseCross: ${creep.name}收到对穿请求`);
  if (
    creep instanceof Creep &&
    (!!creep.fatigue || creep.spawning || !creep.getActiveBodyparts(MOVE))
  ) {
    creep.say("😪");
    debugWarn(
      debug,
      `responseCross: ${creep.name}拒绝对穿，因为有fatigue或者正在孵化,或者没有MOVE`
    );
    return ERR_BUSY;
  }
  response = getCrossRule(creep.memory?.role)(creep) ? OK : ERR_BUSY;
  if (response === ERR_BUSY) {
    debugWarn(debug, `responseCross: ${creep.name}根据其对穿响应规则拒绝对穿`);
    creep.say("👎");
    return response;
  }
  const crossDir = getCrossDirectionRule(creep.memory?.role)(creep, dir);
  const crossResult = creep.move(crossDir);
  creep.say("👍");
  debugLog(
    debug,
    `responseCross: ${creep.name}根据其对穿响应规则响应对穿，对穿方向：${crossDir}，对穿结果：${crossResult}`
  );
  return response;
};

/**
 *
 * @param creep
 * @param pos 期望对穿位置
 * @returns 对穿结果，OK和ERR_NOT_FOUND表示对穿成功，其他表示对穿失败
 */
const requireCross = function (
  creep: Creep | PowerCreep,
  pos: RoomPosition,
  debug: boolean = false
): ERR_NOT_OWNER | ERR_NOT_FOUND | ERR_BUSY | OK | ERR_NO_PATH {
  const frontCreep =
    pos.lookFor(LOOK_CREEPS)[0] || pos.lookFor(LOOK_POWER_CREEPS)[0];
  const frontObstacles = pos
    .lookFor(LOOK_STRUCTURES)
    .filter((str) => Obstacles_Structuretype.includes(str.structureType));

  if (frontObstacles.length > 0) {
    debugWarn(
      debug,
      `requireCross: ${creep.name}前方有障碍物：${frontObstacles[0]}`
    );
    return ERR_NO_PATH;
  }

  const expectDir = creep.pos.getDirectionTo(pos);
  if (!frontCreep) {
    creep.move(expectDir);
    debugLog(debug, `requireCross: ${creep.name}前方无creep，直接移动`);
    return ERR_NOT_FOUND;
  }

  if (!frontCreep.my) {
    debugLog(debug, `requireCross: ${creep.name}前方有非己方的creep`);
    return ERR_NOT_OWNER;
  }
  const response = responseCross(frontCreep, expectDir, debug);
  creep.say(`👉`);
  if (response === OK) {
    debugSuccess(
      debug,
      `requireCross: creep: ${creep.name}向${frontCreep.name}发起对穿成功,对穿方向${expectDir}`
    );
    creep.move(expectDir);
    return OK;
  } else {
    debugWarn(
      debug,
      `requireCross: creep: ${creep.name}向${frontCreep.name}发起对穿失败,对穿方向${expectDir},失败原因${response}`
    );
    return response;
  }
};

const checkArrived = function (creepName: string): boolean {
  const { path, idx } = creepPathCache[creepName];
  return idx >= path.length - 1;
};

/**
 *
 * @param creep 调用goTo的creep
 * @param goal 终点，可以是RoomPosition或者RoomObject
 * @param ops 移动参数
 * @returns 移动结果
 * @description 缓存路径，CostMatrix，creepPathCache
 * 集成了对穿，可进行跨房间移动，暂未实现跨shard移动
 * 会自动检查creep是否已经到达目标，如果已经到达，会返回ERR_NOPATH
 */
const goto = function (
  creep: Creep | PowerCreep,
  goal: RoomPosition | { pos: RoomPosition },
  ops: moveOption
): CreepMoveReturnCode | ERR_NO_PATH {
  if (!(goal instanceof RoomPosition)) goal = goal.pos;
  _.defaults(ops, {
    ignoreCreeps: true,
    veryfyRecursionTimes: 0,
    range: 0,
  });

  const { debug, range } = ops;
  if (!creep.my) {
    debugError(debug, `goto: ${creep.name}不是己方creep，无法移动`);
    return ERR_NOT_OWNER;
  }
  if (creep instanceof Creep) {
    if (creep.fatigue > 0) {
      debugWarn(debug, `goto: ${creep.name}有fatigue`);
      return ERR_TIRED;
    }
    if (!creep.getActiveBodyparts(MOVE)) {
      debugWarn(debug, `goto: ${creep.name}没有MOVE`);
      return ERR_NO_BODYPART;
    }
    if (creep.spawning) {
      debugWarn(debug, `goto: ${creep.name}正在孵化`);
      return ERR_BUSY;
    }
  }

  //配置路径缓存
  if (configPath(creep, goal, ops)) return ERR_NO_PATH;
  //解码路径
  const { pos, dir, end } = decodePathUnit(creep.name, ops.debug);
  //检查是否已经到达目标
  if (checkArrived(creep.name)) {
    debugSuccess(debug, `goto: ${creep.name}已经到达目标`);
    return ERR_NO_PATH;
  }
  //验证路径，路径缓存错误时会自动递归
  if (verifyPath(creep, pos, goal, ops)) {
    if (ops.veryfyRecursionTimes === 0) {
      delete creepPathCache[creep.name];
      debugWarn(
        debug,
        `goto: ${creep.name} 自身路径缓存错误，已移除当前creep缓存，进入递归`
      );
      ++ops.veryfyRecursionTimes;
      return goto(creep, goal, ops);
    } else if (ops.veryfyRecursionTimes === 1) {
      delete pathCache[creepPathCache[creep.name].routekey];
      delete creepPathCache[creep.name];
      debugWarn(
        debug,
        `goto: ${creep.name} 全局路径缓存错误，已移除缓存，进入递归`
      );
      ++ops.veryfyRecursionTimes;
      return goto(creep, goal, ops);
    } else {
      delete pathCache[creepPathCache[creep.name].routekey];
      delete creepPathCache[creep.name];
      debugError(debug, `goto: 路径出现未知错误，停止寻路和移动`);
      return ERR_NO_PATH;
    }
  }

  const crossCheckResult = checkCross(creep, pos, ops.debug);
  switch (crossCheckResult) {
    case "obstruct": {
      debugLog(debug, `goto: ${creep.name}检测到阻塞对穿`);
      const crossResult = requireCross(creep, pos, ops.debug);
      if (crossResult === OK || crossResult === ERR_NOT_FOUND) {
        debugSuccess(
          debug,
          `goto: ${creep.name}对穿成功,对穿类型${crossResult}，对穿结果${crossResult}`
        );
        return OK;
      } else {
        debugWarn(
          debug,
          `goto: ${creep.name}对穿失败,对穿类型${crossResult},返回${crossResult},进入递归,重新寻路`
        );
        ops.ignoreCreeps = false;
        return goto(creep, goal, ops);
      }
    }
    case "center": {
      debugLog(debug, `goto: ${creep.name}检测到中心对穿`);
      const crossResult = requireCross(creep, dirToPos(pos, dir), ops.debug);
      if (crossResult === OK || crossResult === ERR_NOT_FOUND) {
        debugSuccess(
          debug,
          `goto: ${creep.name}对穿成功,对穿类型${crossResult}，对穿结果${crossResult}`
        );
      } else {
        debugWarn(
          debug,
          `goto: ${creep.name}对穿失败,对穿类型${crossResult},返回${crossResult},进入递归,重新寻路`
        );
        ops.ignoreCreeps = false;
        return goto(creep, goal, ops);
      }
      break;
    }
    case "none": {
      creep.move(dir);
      break;
    }
  }
  ++creepPathCache[creep.name].idx;
  return OK;
};

const addAvoidRoom = function (roomName: string) {
  if (!Memory.avoidRooms) Memory.avoidRooms = [];
  if (!Memory.avoidRooms.includes(roomName)) {
    Memory.avoidRooms.push(roomName);
    return `avoidRoom added: ${roomName}, now: ${Memory.avoidRooms}`;
  }
  return `avoidRoom already exists: ${roomName}, now: ${Memory.avoidRooms}`;
};

const removeAvoidRoom = function (roomName: string) {
  if (!Memory.avoidRooms) Memory.avoidRooms = [];
  if (Memory.avoidRooms.includes(roomName)) {
    Memory.avoidRooms = Memory.avoidRooms.filter((room) => room !== roomName);
    console.log(`avoidRoom removed: ${roomName}, now: ${Memory.avoidRooms}`);
    return;
  }
  console.log(`avoidRoom not exists: ${roomName}, now: ${Memory.avoidRooms}`);
};

const addAvoidExit = function (fromRoom: string, toRoom: string) {
  if (!Memory.avoidExits) Memory.avoidExits = {};
  if (!Memory.avoidExits[fromRoom]) Memory.avoidExits[fromRoom] = [];
  if (!Memory.avoidExits[fromRoom].includes(toRoom)) {
    Memory.avoidExits[fromRoom].push(toRoom);
    console.log(
      `avoidExit added: ${fromRoom} -> ${toRoom}, now: ${Memory.avoidExits}`
    );
    return;
  }
  console.log(
    `avoidExit already exists: ${fromRoom} -> ${toRoom}, now: ${Memory.avoidExits}`
  );
};

const removeAvoidExit = function (fromRoom: string, toRoom: string) {
  if (!Memory.avoidExits) Memory.avoidExits = {};
  if (
    Memory.avoidExits[fromRoom] &&
    Memory.avoidExits[fromRoom].includes(toRoom)
  ) {
    Memory.avoidExits[fromRoom] = Memory.avoidExits[fromRoom].filter(
      (room) => room !== toRoom
    );
    console.log(
      `avoidExit removed: ${fromRoom} -> ${toRoom}, now: ${Memory.avoidExits}`
    );
    return;
  }
  console.log(
    `avoidExit not exists: ${fromRoom} -> ${toRoom}, now: ${Memory.avoidExits}`
  );
};

export { addAvoidRoom, removeAvoidRoom, addAvoidExit, removeAvoidExit, goto };
