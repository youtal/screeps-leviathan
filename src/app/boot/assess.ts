/**
 * 文件摘要：app.boot 的判定核心（设计见 docs/design/app/boot.md 第 3、4 节，架构设计 11.3、11.4、11.7）。
 *
 * 所属位置：src/app/boot/，app.boot 内部。纯函数：输入世界事实、Memory 视图与人工指定，输出判定结果
 * （模式、强度、情形、证据与应执行的动作），不读 Game、不写任何状态。闸门与执行在 index.ts。
 * M1 只交付 FRESH_START、RECOVERY、DORMANT、AMBIGUOUS 与 NORMAL：11.5 的 S1 ∧ S2 与 11.6 的 T0 ∧ T2 判为
 * AMBIGUOUS（第 4.3 节）。项目标记的模式为 AMBIGUOUS 时，OURS 分支保持 AMBIGUOUS，直到人工 boot.force。
 * 成本：一次判定遍历 spawn、controller 与指纹中的数组，均为本方对象数量级，只在完整判定时调用。
 */
import type { ProjectMarker, RawMemorySummary } from '@/contracts/boot';
import type { BootMode, Strength } from '@/contracts/mode';
import type { BootFacts } from './facts';

/** 开局时钟的有效窗口：放置 spawn 后多少 tick 内 safe mode 仍可作为时钟（附录 B）。 */
export const T_FRESH = 1500;
/** 时钟不可用时，判为重生所需的最短停运时长（11.4 c′，附录 B）。 */
export const GAP = 100;
/** 放置 spawn 时自带的 safe mode 时长（F2）。 */
export const SAFE_MODE_DURATION = 20000;

/** 11.3 的 memState，另加 UNLOADABLE：标记合法但 Memory 无法加载（第 3.1 节，审计 SR-02）。 */
export type MemState = 'EMPTY' | 'CORRUPT' | 'OURS' | 'OURS_NEWER' | 'FOREIGN' | 'UNLOADABLE';

/** 判定使用的 Memory 视图。 */
export interface MemoryView {
  readonly state: MemState;
  /** 本项目命名空间缺失且能加载，可以经 port.initialize() 初始化。 */
  readonly initializable: boolean;
  /** state 为 OURS 时的当前项目标记，否则为 null。 */
  readonly marker: ProjectMarker | null;
}

/** 判定后应执行的动作：无、初始化本项目命名空间、备份后清空。 */
export type Action = 'none' | 'initialize' | 'clear';

/** 判定结果。 */
export interface Verdict {
  readonly mode: BootMode;
  readonly strength: Strength;
  /** 判定所落的情形，例如 '11.4 b'；连续两次完整判定比较它，中证据清空要求两次一致。 */
  readonly case: string;
  /** 人可读的证据，写入 sys.mode.evidence 与通知正文。 */
  readonly evidence: readonly string[];
  readonly action: Action;
}

/**
 * 合法运营模式的表：以 BootMode 为键加 satisfies 约束，contracts 增删模式而此处未同步时编译失败
 * （与 kernel/memory/marker.ts 的 MODE_TABLE 同一做法，ultrareview 第 9 项）。
 */
const MODE_TABLE = {
  NORMAL: true, RECOVERY: true, FRESH_START: true, TAKEOVER: true, SELF_ADOPT: true,
  SHARD_SEED: true, STRANDED: true, DORMANT: true, AMBIGUOUS: true,
} as const satisfies Record<BootMode, true>;

/** 合法的运营模式，供 boot.force 校验参数；由 MODE_TABLE 的键生成。 */
export const BOOT_MODES: readonly BootMode[] = Object.keys(MODE_TABLE) as BootMode[];

/**
 * @description 由原始 Memory 的概要与当前项目标记得出 Memory 视图（11.3 与第 3 节的表）。
 * @param input 判断依据。
 * @param input.summary 本 kernel 实例加载时的概要。
 * @param input.current 当前可读的项目标记；Memory 不可用（empty 或加载失败）时为 null。
 * @param input.namespace 本项目的命名空间名。
 * @param input.schema 代码支持的根 schema。
 * @returns Memory 视图。
 */
export const memoryView = (input: { readonly summary: RawMemorySummary; readonly current: ProjectMarker | null;
  readonly namespace: string; readonly schema: number }): MemoryView => {
  const { summary, current } = input;
  // 当前可读说明数据就绪：可能是加载所得，也可能是本实例内刚初始化或清空的结果，概要不反映后两者。
  if (current) return { state: 'OURS', initializable: false, marker: current };
  if (!summary.parsed) return { state: 'CORRUPT', initializable: false, marker: null };
  if (summary.empty) return { state: 'EMPTY', initializable: true, marker: null };
  // 命名空间存在而标记不符时加载失败，不能初始化；命名空间缺失时只有外来根键，加载成功。
  if (!summary.marker) return { state: 'FOREIGN', initializable: !summary.rootKeys.includes(input.namespace), marker: null };
  if (summary.marker.schema > input.schema) return { state: 'OURS_NEWER', initializable: false, marker: null };
  return { state: 'UNLOADABLE', initializable: false, marker: null };
};

/**
 * @description 构造判定结果。
 * @param mode 模式。
 * @param strength 证据强度。
 * @param kase 情形。
 * @param evidence 证据。
 * @param action 应执行的动作。
 * @returns 判定结果。
 */
const verdict = (mode: BootMode, strength: Strength, kase: string, evidence: string[], action: Action): Verdict =>
  ({ mode, strength, case: kase, evidence, action });

/**
 * @description 判定当前局面（11.7 的判定顺序；第 4 节）。force 不为空时以人工指定为准：FRESH_START 为一次性指定，
 * Memory 为 EMPTY 时初始化，否则备份后清空（用于确认 11.4 b′ 等情形的清空）；其他模式只在能初始化时初始化，不清空。
 * @param facts 本 tick 的世界事实。
 * @param memory Memory 视图。
 * @param force 人工指定的模式（boot.force），没有时为 null。
 * @returns 判定结果。
 */
export const assess = (facts: BootFacts, memory: MemoryView, force: BootMode | null): Verdict => {
  const mem = `Memory：${memory.state}`;
  if (force !== null) {
    const action: Action = force === 'FRESH_START' ? (memory.state === 'EMPTY' ? 'initialize' : 'clear')
      : memory.initializable ? 'initialize' : 'none';
    return verdict(force, 'strong', 'force', ['人工指定（boot.force）', mem], action);
  }
  if (memory.state === 'OURS_NEWER') return verdict('AMBIGUOUS', 'strong', '11.4 e', [mem, 'Memory 的 schema 高于代码'], 'none');

  const w = openingWorld(facts);
  if (w) return opening(facts, memory, w, mem);
  if (memory.state === 'UNLOADABLE') {
    return verdict('AMBIGUOUS', 'medium', '3.1 UNLOADABLE', [mem, '项目标记合法但 Memory 无法加载，W 不成立'], 'none');
  }

  const placeholder = memory.initializable ? 'initialize' : 'none';
  const s1 = facts.spawns.length === 0 && facts.nonCoreCount === 0 && facts.sites === 0
    && facts.controllers.every((c) => c.level <= 1);
  if (s1 && facts.creepCount >= 1) {
    return verdict('AMBIGUOUS', 'medium', 'M1 S1∧S2', [mem, '没有建筑但有 creep：跨 shard 新据点与滞留判定在 M5 交付'], placeholder);
  }
  if (memory.state === 'OURS') return ours(facts, memory.marker!, mem);
  if (facts.structCount >= 1 || facts.creepCount >= 1) {
    return verdict('AMBIGUOUS', 'medium', 'M1 T0∧T2', [mem, `有资产（建筑 ${facts.structCount}、creep ${facts.creepCount}）：接手判定在 M2 交付`], placeholder);
  }
  return verdict('DORMANT', 'strong', '11.7 DORMANT', [mem, '本 shard 没有任何资产'], 'none');
};

/** 开局世界 W 成立时的 spawn、controller 与 safe mode 时钟。 */
interface Opening {
  readonly spawnId: string;
  readonly room: string;
  /** safe mode 时钟是否可用（11.4 的 clockOk）。 */
  readonly clockOk: boolean;
  /** 时钟可用时推算的放置 spawn 的 tick；不可用时为 undefined。 */
  readonly placementTick: number | undefined;
}

/**
 * @description 判断开局世界 W（11.4 的 W1–W4）并计算 safe mode 时钟。
 * @param facts 世界事实。
 * @returns W 成立时的开局信息，否则为 null。
 */
const openingWorld = (facts: BootFacts): Opening | null => {
  if (facts.spawns.length !== 1 || facts.structCount !== 2 || facts.controllers.length !== 1) return null;
  const spawn = facts.spawns[0];
  const c = facts.controllers[0];
  if (c.room !== spawn.room || facts.sites !== 0 || facts.creepCount !== 0 || facts.pcHere !== 0) return null;
  if (c.level !== 1 || c.progress !== 0) return null;
  const elapsed = c.safeMode === undefined ? undefined : SAFE_MODE_DURATION - c.safeMode;
  const clockOk = elapsed !== undefined && elapsed >= 0 && elapsed <= T_FRESH;
  return { spawnId: spawn.id, room: spawn.room, clockOk, placementTick: clockOk ? facts.time - elapsed : undefined };
};

/**
 * @description 开局世界中的判定（11.4 的情形 a–e，第 4.2 节）；UNLOADABLE 按 CORRUPT 处理（第 3.1 节）。
 * @param facts 世界事实。
 * @param memory Memory 视图。
 * @param w 开局信息。
 * @param mem Memory 状态的证据文本。
 * @returns 判定结果。
 */
const opening = (facts: BootFacts, memory: MemoryView, w: Opening, mem: string): Verdict => {
  const clock = w.clockOk ? `safe mode 时钟可用，放置于 tick ${w.placementTick}` : 'safe mode 时钟不可用';
  const base = [`W 成立（房间 ${w.room}）`, mem, clock];
  if (memory.state === 'EMPTY') return verdict('FRESH_START', 'strong', '11.4 a', base, 'initialize');
  if (memory.state === 'FOREIGN' || memory.state === 'CORRUPT' || memory.state === 'UNLOADABLE') {
    if (w.clockOk) return verdict('FRESH_START', 'strong', '11.4 b', base, 'clear');
    // b′：不清空。外来键只读保留、本系统照常初始化；无法初始化（损坏）时证据不足以运营。
    if (memory.initializable) {
      return verdict('FRESH_START', 'medium', "11.4 b'", [...base, '不清空，确认后以 boot.force(\'FRESH_START\') 清空'], 'initialize');
    }
    return verdict('AMBIGUOUS', 'medium', "11.4 b'", [...base, 'Memory 无法初始化，确认后以 boot.force(\'FRESH_START\') 清空'], 'none');
  }
  // OURS：重生（c、c′）或本局已经运行过（d）。
  const marker = memory.marker!;
  const known = marker.fp.spawnIds.includes(w.spawnId);
  if (w.clockOk) {
    if (!known && marker.lastRun < w.placementTick!) {
      return verdict('FRESH_START', 'strong', '11.4 c', [...base, `spawn 不在指纹中，lastRun ${marker.lastRun} 早于放置`], 'clear');
    }
    return verdict('NORMAL', 'strong', '11.4 d', [...base, known ? 'spawn 在指纹中' : `lastRun ${marker.lastRun} 不早于放置`], 'none');
  }
  if (known) return verdict('NORMAL', 'strong', '11.4 d', [...base, 'spawn 在指纹中'], 'none');
  if (!marker.fp.rooms.includes(w.room) && facts.time - marker.lastRun > GAP) {
    return verdict('FRESH_START', 'medium', "11.4 c'", [...base, `spawn 与房间都不在指纹中，停运 ${facts.time - marker.lastRun} tick`], 'clear');
  }
  return verdict('AMBIGUOUS', 'medium', "11.4 c'", [...base, '时钟不可用，且房间在指纹中或停运时间不足'], 'none');
};

/**
 * @description Memory 属于本系统且不在开局世界中的判定：RECOVERY 或 NORMAL（11.7）；已持久化的模式为 AMBIGUOUS 时保持。
 * @param facts 世界事实。
 * @param marker 当前项目标记。
 * @param mem Memory 状态的证据文本。
 * @returns 判定结果。
 */
const ours = (facts: BootFacts, marker: ProjectMarker, mem: string): Verdict => {
  if (marker.mode.mode === 'AMBIGUOUS') {
    return verdict('AMBIGUOUS', marker.mode.strength, '11.7 OURS 保持 AMBIGUOUS', [mem, '项目标记的模式为 AMBIGUOUS，等待人工 boot.force'], 'none');
  }
  const rooms = facts.controllers.length;
  const spawns = facts.spawns.length;
  const fpRooms = marker.fp.rooms.length;
  const fpSpawns = marker.fp.spawnIds.length;
  const asset = `房间 ${rooms}/${fpRooms}，spawn ${spawns}/${fpSpawns}（当前/指纹）`;
  if (rooms * 2 < fpRooms || spawns * 2 < fpSpawns || (spawns === 0 && fpSpawns > 0)) {
    return verdict('RECOVERY', 'strong', '11.7 RECOVERY', [mem, `资产大幅减少：${asset}`], 'none');
  }
  return verdict('NORMAL', 'strong', '11.7 NORMAL', [mem, asset], 'none');
};
