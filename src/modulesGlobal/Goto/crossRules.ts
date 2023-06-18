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
