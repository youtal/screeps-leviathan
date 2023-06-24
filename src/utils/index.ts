export * from "./console";
import { Obstacles_Structuretype } from "@/constants";
import { AppLifecycleCallbacks, AnyCallback } from "@/freamWork/types";

const dirToPos = function (
  oriPos: RoomPosition,
  dir: DirectionConstant
): RoomPosition {
  let x = oriPos.x + [0, 0, 1, 1, 1, 0, -1, -1, -1][dir];
  let y = oriPos.y + [0, -1, -1, 0, 1, 1, 1, 0, -1][dir];
  return new RoomPosition(x, y, oriPos.roomName);
};

const isPosWalkable = function (position: RoomPosition): boolean {
  const lookResult = position.look();

  //先检查地形
  let terrainCheck =
    lookResult.find((l) => l.type === LOOK_TERRAIN).terrain === "wall";
  if (terrainCheck) return false;

  //检查建筑
  let structures = lookResult.filter((l) => l.type === LOOK_STRUCTURES);
  if (structures.length > 0) {
    const structureCheck = structures.some((_lookObject) => {
      const lookObject = _lookObject as any;
      return (
        Obstacles_Structuretype.includes(lookObject.structure.structureType) ||
        (lookObject.structure.structureType === STRUCTURE_RAMPART &&
          !(<StructureRampart>lookObject.structure).my)
      );
    });
    if (structureCheck) return false;
  }

  //检查工地
  let constructionSites = lookResult.filter(
    (l) => l.type === LOOK_CONSTRUCTION_SITES
  );
  if (constructionSites.length > 0) {
    const constructionSiteCheck = constructionSites.some((_lookObject) => {
      const lookObject = _lookObject as any;
      return (
        Obstacles_Structuretype.includes(
          lookObject.constructionSite.structureType
        ) && lookObject.constructionSite.my
      );
    });
    if (constructionSiteCheck) return false;
  }

  //检查 creep
  let creeps = lookResult.filter((l) => l.type === LOOK_CREEPS);
  if (creeps.length > 0) {
    return false;
  }

  //检查 power creep
  let powerCreeps = lookResult.filter((l) => l.type === LOOK_POWER_CREEPS);
  if (powerCreeps.length > 0) {
    return false;
  }

  return true;
};

const getNearPos = function (oriPos: RoomPosition): RoomPosition[] {
  let res: RoomPosition[] = [];
  const tmpArr = [-1, 0, 1];
  const { x, y, roomName } = oriPos;
  for (let i of tmpArr)
    for (let j of tmpArr) {
      //跳过自身
      if (i === 0 && j === 0) continue;
      let [dx, dy] = [x + i, y + j];
      //跳过边界
      if (dx > 49 || dy > 49 || dx < 0 || dy < 0) continue;
      res.push(new RoomPosition(dx, dy, roomName));
    }
  return res;
};

const assmblePlugins = (Plugins: AppLifecycleCallbacks[]) => {
  const bornCallbacks: AnyCallback[] = [];
  const raloadCallbacks: AnyCallback[] = [];
  const tickStartCallbacks: AnyCallback[] = [];
  const tickEndCallbacks: AnyCallback[] = [];
  const res: AppLifecycleCallbacks = {
    born: () => {
      bornCallbacks.forEach((callback) => callback());
    },
    reload: () => {
      raloadCallbacks.forEach((callback) => callback());
    },
    tickStart: () => {
      tickStartCallbacks.forEach((callback) => callback());
    },
    tickEnd: () => {
      tickEndCallbacks.forEach((callback) => callback());
    },
  };
  Plugins.forEach((plugin) => {
    plugin.born && bornCallbacks.push(plugin.born);
    plugin.reload && raloadCallbacks.push(plugin.reload);
    plugin.tickStart && tickStartCallbacks.push(plugin.tickStart);
    plugin.tickEnd && tickEndCallbacks.push(plugin.tickEnd);
  });
  return res;
};

export { dirToPos, isPosWalkable, getNearPos, assmblePlugins };
