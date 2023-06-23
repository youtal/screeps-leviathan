export enum Role {
  Worker = "🛠",
  Manager = "🛻",
  Processor = "⚓",
  River = "🚁",
  Signer = "🔈",
  Reserver = "🔉",
  Claimer = "🔊",
  Archer = "🏹",
  Infantry = "🗡",
  Healer = "🚑",
  Dismantler = "🔨",
  Knight = "🐎",
  Guard = "🛡",
  Operator = "🔧",
}

export type RoleWorker = Role.Worker;
export type RoleManager = Role.Manager;
export type RoleProcessor = Role.Processor;
export type RoleRiver = Role.River;
export type BaseRole = RoleWorker | RoleManager | RoleProcessor | RoleRiver;
export type RoleSigner = Role.Signer;
export type RoleReserver = Role.Reserver;
export type RoleClaimer = Role.Claimer;
export type ClaimRole = RoleSigner | RoleReserver | RoleClaimer;
export type RoleArcher = Role.Archer;
export type RoleInfantry = Role.Infantry;
export type RoleHealer = Role.Healer;
export type RoleDismantler = Role.Dismantler;
export type RoleKnight = Role.Knight;
export type RoleGuard = Role.Guard;
export type WarriorRole =
  | RoleArcher
  | RoleInfantry
  | RoleHealer
  | RoleDismantler
  | RoleKnight
  | RoleGuard;

export type RoleOperator = Role.Operator;
export type PowerRole = RoleOperator;
export type RoleConstant = BaseRole | ClaimRole | WarriorRole | PowerRole;

export type StagePrepare = "▶️";
export type StageCharge = "⏩";
export type StageWork = "⏯️";
export type CreepActionStageType = StagePrepare | StageCharge | StageWork;

export enum CreepActionStage {
  Prepare = "▶️",
  Charge = "⏩",
  Work = "⏯️",
}

export type TaskTypeHarvest = "h";
export type TaskTypeDismantle = "d";
export type TaskTypeBuild = "b";
export type TaskTypeRepair = "r";
export type TaskTypeUpgrade = "u";
export type TaskType =
  | TaskTypeHarvest
  | TaskTypeDismantle
  | TaskTypeBuild
  | TaskTypeRepair
  | TaskTypeUpgrade;

export enum workTask {
  Harvest = "h",
  Dismantle = "d",
  Build = "b",
  Repair = "r",
  Upgrade = "u",
}

export interface RoleData {
  [Role.Worker]: roleWorkerMemory;
  [Role.Manager]: defaultCreepMemory;
  [Role.Processor]: defaultCreepMemory;
  [Role.River]: defaultCreepMemory;
  [Role.Signer]: defaultCreepMemory;
  [Role.Reserver]: defaultCreepMemory;
  [Role.Claimer]: defaultCreepMemory;
  [Role.Archer]: defaultCreepMemory;
  [Role.Infantry]: defaultCreepMemory;
  [Role.Healer]: defaultCreepMemory;
  [Role.Dismantler]: defaultCreepMemory;
  [Role.Knight]: defaultCreepMemory;
  [Role.Guard]: defaultCreepMemory;
  [Role.Operator]: defaultCreepMemory;
}

export interface CreepConfig<R extends RoleConstant = RoleConstant> {
  /**
   * @default false
   * 配置没有改属性时，当作 false 处理
   */
  keepSpawn?: (mem: CreepRoleMemory<R>) => boolean;

  /**
   * 准备阶段
   *
   * creep 出生后会执行该方法来完成一些需要准备的工作，根据返回值决定下个阶段，必选项
   */
  prepare: (creep: RoleCreep<R>) => CreepActionStage;

  /**
   * 获取资源阶段
   *
   * creep 会执行该方法来获取资源，根据返回值决定下个阶段，非必选项
   */
  charge?: (creep: RoleCreep<R>) => CreepActionStage;

  /**
   * 工作阶段
   *
   * creep 会执行该方法来完成工作，根据返回值决定下个阶段，必选项
   */
  work: (creep: RoleCreep<R>) => CreepActionStage;

  /**
   * 本配置角色body部件配置
   */
  body: (room: Room, mem: CreepRoleMemory<R>) => BodyPartConstant[];
}

declare global {
  interface defaultCreepMemory {}
  interface roleWorkerMemory extends defaultCreepMemory {
    taskType: TaskType;
    targetId: Id<RoomObject>;
  }
  interface CreepMemory {
    role: RoleConstant;
    actionStage: CreepActionStage;
    stand?: boolean;
    bornRoom: string;
  }
  interface PowerCreepMemory {
    role: RoleConstant;
    actionStage: CreepActionStage;
    stand?: boolean;
    bornRoom: string;
  }
  interface CreepRoleMemory<R extends RoleConstant> extends CreepMemory {
    data: RoleData[R];
  }

  interface RoleCreep<R extends RoleConstant> extends Creep {
    memory: CreepRoleMemory<R>;
  }

  interface PowerRoleCreep<R extends RoleConstant> extends PowerCreep {
    memory: CreepRoleMemory<R>;
  }
}
