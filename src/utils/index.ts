export * from "./console";

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

export { dirToPos, isPosWalkable };
