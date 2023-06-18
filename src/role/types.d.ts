type RoleWorker = "🛠";
type RoleManager = "🛻";
type RoleProcessor = "⚓";
type RoleRiver = "🚁";
type BaseRole = RoleWorker | RoleManager | RoleProcessor | RoleRiver;

type RoleSigner = "🔈";
type RoleReserver = "🔉";
type RoleClaimer = "🔊";
type ClaimRole = RoleSigner | RoleReserver | RoleClaimer;

type RoleArcher = "🏹";
type RoleInfantry = "🗡";
type RoleHealer = "🚑";
type RoleDismantler = "🔨";
type RoleKnight = "🐎";
type RoleGuard = "🛡";
type WarriorRole =
  | RoleArcher
  | RoleInfantry
  | RoleHealer
  | RoleDismantler
  | RoleKnight
  | RoleGuard;

type RoleOperator = "🔧";
type PowerRole = RoleOperator;

type RoleConstant = BaseRole | ClaimRole | WarriorRole | PowerRole;

declare const RoleWorker: RoleWorker;
declare const RoleManager: RoleManager;
declare const RoleProcessor: RoleProcessor;
declare const RoleRiver: RoleRiver;
declare const RoleSigner: RoleSigner;
declare const RoleReserver: RoleReserver;
declare const RoleClaimer: RoleClaimer;
declare const RoleArcher: RoleArcher;
declare const RoleInfantry: RoleInfantry;
declare const RoleHealer: RoleHealer;
declare const RoleDismantler: RoleDismantler;
declare const RoleKnight: RoleKnight;
declare const RoleGuard: RoleGuard;
declare const RoleOperator: RoleOperator;

type StagePrepare = "▶️";
type StageCharge = "⏩";
type StageWork = "⏯️";
type CreepActionStage = StagePrepare | StageCharge | StageWork;

declare const StagePrepare: StagePrepare;
declare const StageCharge: StageCharge;
declare const StageWork: StageWork;

interface defaultCreepMemory {
  bornRoom: string;
}

interface CreepMemory {
  role: RoleConstant;
  actionStage: CreepActionStage;
  stand?: boolean;
}

interface PowerCreepMemory {
  role: RoleConstant;
  actionStage: CreepActionStage;
  stand?: boolean;
}

interface RoleData {
  [RoleWorker]: defaultCreepMemory;
  [RoleManager]: defaultCreepMemory;
  [RoleProcessor]: defaultCreepMemory;
  [RoleRiver]: defaultCreepMemory;
  [RoleSigner]: defaultCreepMemory;
  [RoleReserver]: defaultCreepMemory;
  [RoleClaimer]: defaultCreepMemory;
  [RoleArcher]: defaultCreepMemory;
  [RoleInfantry]: defaultCreepMemory;
  [RoleHealer]: defaultCreepMemory;
  [RoleDismantler]: defaultCreepMemory;
  [RoleKnight]: defaultCreepMemory;
  [RoleGuard]: defaultCreepMemory;
  [RoleOperator]: defaultCreepMemory;
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

interface CreepConfig<R extends RoleConstant = RoleConstant> {
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
