import { dirToPos, isPosWalkable } from "@/utils";

type AllowCrossRule = (creep: Creep | PowerCreep) => boolean;

/**
 * 默认的对穿规则
 */
const defaultCrossRule: AllowCrossRule = (creep) => !creep.memory?.stand;

/**
 * 通用对穿规则1，StageWork 阶段不允许对穿
 */
const refuseWhenWork: AllowCrossRule = (creep) =>
  creep.memory.actionStage !== StageWork;

type CrossRuleMap = Partial<Record<RoleConstant | "default", AllowCrossRule>>;

const crossRuleMap: CrossRuleMap = {
  [RoleWorker]: defaultCrossRule,
  [RoleManager]: defaultCrossRule,
  default: defaultCrossRule,
};

type CrossDirectionRule = (
  creep: Creep | PowerCreep,
  direction: DirectionConstant
) => DirectionConstant;

/**
 * 默认的对穿方向规则
 */
const defaultCrossDirectionRule: CrossDirectionRule = (
  creep: Creep | PowerCreep,
  direction: DirectionConstant
) => {
  let resArr: DirectionConstant[] = [
    direction + 1,
    direction - 1,
    direction + 2,
    direction - 2,
    direction + 3,
    direction - 3,
  ].map((d) => (d > 8 ? d - 8 : d < 1 ? d + 8 : d)) as DirectionConstant[];
  const res = resArr.find((d) => isPosWalkable(dirToPos(creep.pos, d)));
  return res
    ? res
    : direction + 4 > 8
    ? ((direction - 4) as DirectionConstant)
    : ((direction + 4) as DirectionConstant);
};

/**
 * 靠近目标的对穿方向规则，用于worker工作时使用，该规则会尽量让creep靠近目标，确保worker响应对穿后能够继续工作
 */
const closeToTargetCrossDirectionRule: CrossDirectionRule = (
  creep: Creep | PowerCreep,
  direction: DirectionConstant
) => {
  // 如果没有目标或者目标已经不存在，则使用默认的对穿方向规则
  if (!creep.memory.targetId || !Game.getObjectById(creep.memory.targetId))
    return defaultCrossDirectionRule(creep, direction);

  const target = Game.getObjectById(creep.memory.targetId);
  let dir = creep.pos.getDirectionTo(target.pos);
  if (dir) {
    const resArr: DirectionConstant[] = [
      dir,
      dir + 1,
      dir - 1,
      dir + 2,
      dir - 2,
    ].map((d) => (d > 8 ? d - 8 : d < 1 ? d + 8 : d)) as DirectionConstant[];
    const res = resArr.find((d) => isPosWalkable(dirToPos(creep.pos, d)));
    if (res) return res;
  }

  // 如果没有找到合适的方向，则使用默认的对穿方向规则
  return defaultCrossDirectionRule(creep, direction);
};

type CrossDirectionRuleMap = Partial<
  Record<RoleConstant | "default", CrossDirectionRule>
>;

const crossDirectionRuleMap: CrossDirectionRuleMap = {
  [RoleWorker]: closeToTargetCrossDirectionRule,
  default: defaultCrossDirectionRule,
};

export { crossRuleMap, crossDirectionRuleMap };
