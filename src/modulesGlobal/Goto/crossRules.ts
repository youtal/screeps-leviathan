import { dirToPos, isPosWalkable } from "@/utils";
import {
  RoleConstant,
  CreepActionStage,
  RoleWorker,
  workTask,
  Role,
} from "@/role/types";

type AllowCrossRule = (
  //creep: RoleCreep<RoleConstant> | PowerRoleCreep<RoleConstant>
  creep: Creep | PowerCreep
) => boolean;

/**
 * 默认的对穿规则
 */
const defaultCrossRule: AllowCrossRule = (creep) => !creep.memory?.stand;

/**
 * 通用对穿规则1，StageWork 阶段不允许对穿
 */
const refuseWhenWork: AllowCrossRule = (creep) =>
  creep.memory.actionStage !== CreepActionStage.Work;

/**
 * 适用于worker的对穿规则，执行harvest任务时不允许对穿
 */
const CrossRuleWorker: AllowCrossRule = (creep: RoleCreep<RoleWorker>) => {
  const { data } = creep.memory;
  return data.taskType === workTask.Harvest
    ? refuseWhenWork(creep)
    : defaultCrossRule(creep);
};

type CrossRuleMap = Partial<Record<RoleConstant | "default", AllowCrossRule>>;

const crossRuleMap: CrossRuleMap = {
  [Role.Worker]: CrossRuleWorker,
  [Role.Manager]: defaultCrossRule,
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

const crossDirectionRuleWorker: CrossDirectionRule = (
  creep: RoleCreep<RoleWorker>,
  direction: DirectionConstant
) => {
  const { data } = creep.memory;
  // 如果没有目标或者目标已经不存在，则使用默认的对穿方向规则
  if (!data.targetId || !Game.getObjectById(data.targetId))
    return defaultCrossDirectionRule(creep, direction);

  const target = Game.getObjectById(data.targetId);
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
  [Role.Worker]: crossDirectionRuleWorker,
  default: defaultCrossDirectionRule,
};

const getCrossRule = (role?: RoleConstant): AllowCrossRule => {
  if (!role) return crossRuleMap.default;
  return crossRuleMap[role] || crossRuleMap.default;
};

const getCrossDirectionRule = (role?: RoleConstant): CrossDirectionRule => {
  if (!role) return crossDirectionRuleMap.default;
  return crossDirectionRuleMap[role] || crossDirectionRuleMap.default;
};
export { getCrossRule, getCrossDirectionRule };
