/**
 * 文件摘要：app.boot，启动判定的宿主（设计见 docs/design/app/boot.md，架构设计 6.7、11.1–11.4、11.7–11.9）。
 *
 * 所属位置：src/app/boot/，由 app.assembly 以 createBoot 创建并交给 kernel；kernel 在每 tick 的 boot 阶段最先调用。
 * 每 tick 流程：读取廉价不变量（spawn、建筑、creep 数与 Memory 是否就绪）→ 需要时完整判定（assess.ts）→
 * 按 11.8 的闸门经特权端口执行（初始化；备份后清空；必要时先软重置）→ setMode 发布并在模式变化时 Game.notify →
 * 按 6.7 维护项目标记（lastRun 每 tick、release 每个实例一次、fp 每 FP_INTERVAL tick 与完整判定后，模式为 AMBIGUOUS 或 RECOVERY 时不写 fp）。
 * dryRun 只判定与发布，不调用端口、不写项目标记。
 * 状态（heap，随 kernel 实例存在，软重置与 global reset 后从头开始）：加载时的概要、上一 tick 的不变量、
 * 是否需要在下一 tick 重新判定、连续判定的情形与次数（中证据清空要求两次一致）、本实例是否有过非暂停的就绪 tick
 * （此后普通模块可能已 setup，清空前须软重置）、本 Memory 的清空被闸门拦下后是否冻结 lastRun 与 fp、
 * 人工指定的模式（同时持久化在 part.boot.control）与 dryRun 覆盖值。
 */
import type { BootDefinition, ProjectMarker, RawMemorySummary } from '@/contracts/boot';
import type { Accessor, UnitSpec } from '@/contracts/memory';
import type { BootMode, BootModeView } from '@/contracts/mode';
import type { BootSettings } from '@/contracts/settings';
import { BOOT_MODES, type MemoryView, type Verdict, assess, memoryView } from './assess';
import type { BootCounts, BootFacts } from './facts';

export { readGameCounts, readGameFacts } from './facts';
export type { BootCounts, BootFacts } from './facts';

/** 指纹的定期更新间隔（6.7）。 */
export const FP_INTERVAL = 100;

/** 创建 boot 的选项，由 app.assembly 注入。 */
export interface BootOptions {
  /** Memory 身份中判定需要的部分：命名空间（判断能否初始化）与代码支持的 schema（11.3）。 */
  readonly identity: { readonly namespace: string; readonly schema: number };
  /** 构建注入的版本号，每个实例写入一次 sys.release（6.7）。 */
  readonly release: string;
  /** 使用者设置：autoClear 与 dryRun。 */
  readonly settings: BootSettings;
  /**
   * @description 当前 tick。
   * @returns Game.time。
   */
  time(): number;
  /**
   * @description 读取完整判定所需的世界事实。
   * @returns 本 tick 的事实。
   */
  facts(): BootFacts;
  /**
   * @description 读取每 tick 的廉价不变量。
   * @returns spawn、建筑与 creep 的数量。
   */
  counts(): BootCounts;
  /**
   * @description 发出游戏通知（Game.notify），模式变化时调用。
   * @param message 纯文本通知。
   * @returns 无返回值。
   */
  notify(message: string): void;
}

/** boot 分区 control 的数据：人工指定的模式，没有时为 null（第 8 节）。 */
type Control = { force: BootMode | null };

/** control 分区的声明；只有版本 1。 */
const CONTROL_SPEC: UnitSpec<Control> = {
  version: 1,
  /**
   * @description 初始数据：没有人工指定。
   * @returns 初始数据。
   */
  initialize: () => ({ force: null }),
  /**
   * @description 只有版本 1；读到其他版本时丢弃人工指定，回到自动判定。
   * @returns 初始数据。
   */
  migrate: () => ({ force: null }),
};

/**
 * @description 判断一个数量是否突变：在 0 与非 0 之间变化，或减少一半以上（第 5 节）。
 * @param before 上一 tick 的数量。
 * @param after 本 tick 的数量。
 * @returns 突变时为 true。
 */
const jumped = (before: number, after: number): boolean => (before === 0) !== (after === 0) || after * 2 < before;

/**
 * @description 判断廉价不变量是否突变：spawn 数变化，或建筑数、creep 数突变。Memory 就绪状态由调用方比较。
 * @param before 上一 tick 的不变量。
 * @param after 本 tick 的不变量。
 * @returns 需要完整判定时为 true。
 */
const mutated = (before: BootCounts, after: BootCounts): boolean =>
  before.spawns !== after.spawns || jumped(before.structures, after.structures) || jumped(before.creeps, after.creeps);

/**
 * @description 由世界事实生成世界指纹（6.7）。
 * @param facts 世界事实。
 * @returns 本方房间名、spawn id 与 creep 数。
 */
const fingerprint = (facts: BootFacts): ProjectMarker['fp'] =>
  ({ rooms: facts.controllers.map((c) => c.room), spawnIds: facts.spawns.map((s) => s.id), creepCount: facts.creepCount });

/**
 * @description 把判定结果格式化为一行文本，用于日志、通知与 boot.assess()。
 * @param v 判定结果。
 * @returns 形如 `FRESH_START（强）｜11.4 a｜证据…` 的文本。
 */
const describe = (v: Verdict): string => `${v.mode}（${v.strength === 'strong' ? '强' : '中'}）｜${v.case}｜${v.evidence.join('；')}`;

/**
 * @description 在判定结果的证据末尾追加一条说明。
 * @param v 判定结果。
 * @param note 说明。
 * @returns 新的判定结果。
 */
const noted = (v: Verdict, note: string): Verdict => ({ ...v, evidence: [...v.evidence, note] });

/** 执行判定结果的产出：发布的判定、本 tick 是否暂停，以及清空是否尚待执行（此时不写项目标记）。 */
interface Outcome {
  readonly verdict: Verdict;
  readonly paused: boolean;
  readonly hold: boolean;
}

/**
 * @description 创建 app.boot 的定义（11.1）。
 * @param options 身份、版本号、设置与游戏端口。
 * @returns 交给 kernel 的 boot 定义。
 */
export const createBoot = (options: BootOptions): BootDefinition => ({
  /**
   * @description 每个 kernel 实例调用一次：建立 heap 状态、注册控制台命令，返回 boot 钩子。
   * @param ctx boot 上下文。
   * @returns 含 boot 钩子的对象。
   */
  setup(ctx) {
    // 本实例加载时的原始 Memory 概要；首个 tick 读取，之后不变（bootPort 设计第 3 节）。
    let summary: RawMemorySummary | undefined;
    // 上一 tick 的廉价不变量与 Memory 是否就绪；undefined 表示本实例尚未运行，首个 tick 必然完整判定。
    let counts: BootCounts | undefined;
    let wasReady = false;
    // 下一 tick 须重新完整判定：备份进行中、中证据等待确认、人工指定变化。
    let rejudge = false;
    // 连续完整判定落在同一情形的次数；中证据清空要求至少 2（11.8）。
    let streak = { case: '', count: 0 };
    // 本实例是否有过 Memory 就绪且非暂停的 tick：kernel 在这样的 tick 结束前 setup 普通模块，此后清空须先软重置。
    let ranUnpaused = false;
    // 本系统 Memory 的清空被闸门拦下（autoClear 关闭或备份失败）后为 true：不写 lastRun 与 fp，保留重生证据，
    // 直到下一次完整判定重新得出结论；global reset 后首个 tick 必然完整判定，届时按事实重新设定。
    let frozen = false;
    let releaseWritten = false;
    // 人工指定的模式；forceSynced 为 false 时尚未与 control 分区同步（Memory 就绪后同步）。
    let forced: BootMode | null = null;
    let forceSynced = false;
    // 控制台对 dryRun 的覆盖，只存于 heap；undefined 时取使用者设置。
    let dryRunOverride: boolean | undefined;
    // 本实例最近一次发布的模式视图。
    let view: BootModeView | undefined;
    // control 分区的访问器；初始化或清空后失效，置为 undefined 重新取得。
    let control: Accessor<Control> | undefined;

    /**
     * @description 当前是否处于 dryRun。
     * @returns dryRun 时为 true。
     */
    const dryRun = (): boolean => dryRunOverride ?? options.settings.dryRun;

    /**
     * @description 读取当前项目标记；Memory 为 empty 或加载失败时访问抛错，返回 null。
     * @returns 项目标记（只读引用）或 null。
     */
    const marker = (): ProjectMarker | null => {
      try { return ctx.sys.root() as ProjectMarker; } catch { return null; }
    };

    /**
     * @description 取得 control 分区的访问器；Memory 不可用（项目标记不可读）时为 undefined。只以项目标记判断可用性，
     * 不捕获 partition 的异常：Memory 就绪时它抛错说明声明或数据有误，应传播给 kernel 或控制台，而不是静默丢失人工指定。
     * @returns 访问器或 undefined。
     * @throws {Error} Memory 就绪但分区申请失败。
     */
    const controlAccessor = (): Accessor<Control> | undefined => {
      if (!control) {
        if (marker() === null) return undefined;
        control = ctx.memory.partition('control', CONTROL_SPEC);
      }
      return control;
    };

    /**
     * @description 同步人工指定：Memory 就绪后，heap 中有指定时写入分区，否则从分区读取（跨 global reset 保留）。
     * @returns 无返回值。
     */
    const syncForce = (): void => {
      if (forceSynced) return;
      const c = controlAccessor();
      if (!c) return;
      if (forced !== null) c.set(['force'], forced);
      else forced = (c.get(['force']) as BootMode | null | undefined) ?? null;
      forceSynced = true;
    };

    /**
     * @description 保存人工指定：写入 heap，Memory 可用时同时写入分区。
     * @param mode 指定的模式；null 为取消。
     * @returns 无返回值。
     */
    const saveForce = (mode: BootMode | null): void => {
      forced = mode;
      const c = controlAccessor();
      if (c) c.set(['force'], mode);
      forceSynced = c !== undefined;
    };

    /**
     * @description 初始化或清空之后：旧的分区访问器失效，下一次使用时重新取得并同步人工指定。
     * @returns 无返回值。
     */
    const afterRebuild = (): void => {
      control = undefined;
      forceSynced = false;
    };

    /**
     * @description 由当前状态得出 Memory 视图。
     * @returns Memory 视图。
     */
    const memory = (): MemoryView => memoryView({ summary: summary!, current: marker(),
      namespace: options.identity.namespace, schema: options.identity.schema });

    /**
     * @description 清空被闸门拦下时改判 AMBIGUOUS（中）并通知；能初始化时仍初始化，使生存层可以运行。
     * Memory 属于本系统时（重生 c、c′ 或人工指定）冻结 lastRun 与 fp：重生的证据正是"spawn 不在指纹中、lastRun 早于放置"，
     * 照常维护会使之后的完整判定改为 11.4 d NORMAL，相当于绕过 autoClear 认领上一局的 Memory。模式仍写入 sys.mode。
     * @param v 原判定结果。
     * @param mem 判定时的 Memory 视图。
     * @param reason 拦下的原因。
     * @returns 发布的判定结果；不暂停，也不保留清空。
     */
    const blocked = (v: Verdict, mem: MemoryView, reason: string): Outcome => {
      frozen = mem.state === 'OURS';
      if (mem.initializable) { ctx.port.initialize(); afterRebuild(); }
      return { verdict: { ...v, mode: 'AMBIGUOUS', strength: 'medium', evidence: [...v.evidence, reason], action: 'none' }, paused: false, hold: false };
    };

    /**
     * @description 按 11.8 的闸门执行判定结果的动作（第 6 节）。
     * @param v 判定结果。
     * @param mem 判定时的 Memory 视图。
     * @returns 发布的判定结果、本 tick 是否因备份或软重置而暂停，以及清空是否尚待执行。
     */
    const execute = (v: Verdict, mem: MemoryView): Outcome => {
      if (dryRun()) return { verdict: noted(v, 'dryRun：未执行任何操作'), paused: false, hold: false };
      const once = v.case === 'force' && v.mode === 'FRESH_START';
      if (v.action === 'initialize') {
        if (mem.initializable) { ctx.port.initialize(); afterRebuild(); }
        if (once) forced = null;
        return { verdict: v, paused: false, hold: false };
      }
      if (v.action !== 'clear') return { verdict: v, paused: false, hold: false };
      // autoClear 只约束自动判定的清空；boot.force('FRESH_START') 本身是人工确认，不受它约束（boot 设计第 6.1 节）。
      if (!options.settings.autoClear && v.case !== 'force') return blocked(v, mem, 'autoClear 关闭，未清空');
      if (v.strength === 'medium' && streak.count < 2) {
        // 中证据先开始备份：备份跨 tick，期间为暂停 tick，普通模块不会 setup；下一 tick 再判定一次确认。
        rejudge = true;
        const state = ctx.port.backup();
        if (state === 'failed') return blocked(v, mem, '备份失败，未清空');
        return { verdict: noted(v, '中证据，等待下一次判定确认'), paused: state === 'pending', hold: true };
      }
      if (ranUnpaused) {
        // 11.4 附加规则 1：本实例的普通模块可能已 setup，先软重置，新实例重新判定后再备份与清空。
        ctx.port.softReset();
        return { verdict: noted(v, '普通模块已运行，先软重置'), paused: true, hold: true };
      }
      const state = ctx.port.backup();
      if (state === 'pending') { rejudge = true; return { verdict: noted(v, '备份进行中'), paused: true, hold: true }; }
      if (state === 'failed') return blocked(v, mem, '备份失败，未清空');
      ctx.port.clearMemory();
      ctx.port.clearInterShard();
      afterRebuild();
      if (once) forced = null;
      return { verdict: noted(v, '已备份并清空'), paused: false, hold: false };
    };

    /**
     * @description 发布模式：setMode，Memory 可写时写入 sys.mode；模式或强度变化时记录日志并 Game.notify（11.8）。
     * since 只在模式变化时更新。本实例首次发布时以执行动作之前持久化的模式为比较基准：初始化与清空生成的标记
     * 带有占位模式（AMBIGUOUS/中，bootPort 设计第 4 节），不能当作"之前的模式"，否则会漏发通知。
     * @param v 判定结果。
     * @param time 当前 tick。
     * @param hold 清空是否尚待执行；此时不写项目标记，保留判定所依据的证据（见 maintain）。
     * @param before 执行动作之前的项目标记；当时 Memory 不可用为 null。
     * @returns 无返回值。
     */
    const publish = (v: Verdict, time: number, hold: boolean, before: ProjectMarker | null): void => {
      const current = marker();
      const previous: BootModeView | undefined = view
        ?? (before ? { mode: before.mode.mode, strength: before.mode.strength, since: before.mode.since } : undefined);
      const since = previous && previous.mode === v.mode ? previous.since : time;
      view = Object.freeze({ mode: v.mode, strength: v.strength, since });
      ctx.setMode(view);
      if (current && !dryRun() && !hold) ctx.sys.set(['mode'], { mode: v.mode, strength: v.strength, since, evidence: [...v.evidence] });
      if (previous && previous.mode === v.mode && previous.strength === v.strength) return;
      const text = describe(v);
      if (v.mode === 'AMBIGUOUS') ctx.log.warn(`启动判定：${text}`); else ctx.log.info(`启动判定：${text}`);
      try { options.notify(`tick ${time}：启动判定 ${text}`); } catch (error) { ctx.log.error('启动判定通知发送失败', error); }
    };

    /**
     * @description 完整判定一次并执行、发布（第 4–6 节）。
     * @param time 当前 tick。
     * @returns 本次读取的事实、本 tick 是否暂停，以及清空是否尚待执行。
     */
    const judge = (time: number): { facts: BootFacts; paused: boolean; hold: boolean } => {
      const facts = options.facts();
      const mem = memory();
      // 执行可能初始化或清空，先保存执行前的标记供 publish 比较模式。
      const before = mem.marker;
      const v = assess(facts, mem, forced);
      streak = v.case === streak.case ? { case: v.case, count: streak.count + 1 } : { case: v.case, count: 1 };
      rejudge = false;
      frozen = false;
      const outcome = execute(v, mem);
      ctx.log.debug(() => `M1 判定 case=${v.case} mode=${outcome.verdict.mode} action=${v.action} paused=${outcome.paused} hold=${outcome.hold}`);
      publish(outcome.verdict, time, outcome.hold, before);
      return { facts, paused: outcome.paused, hold: outcome.hold };
    };

    /**
     * @description 维护项目标记（6.7，第 7 节）：lastRun 每 tick；release 每个实例一次；fp 在完整判定后与每 FP_INTERVAL tick，
     * 模式为 RECOVERY 时不更新，保留损失前的资产作为恢复的比较基准。dryRun 与 Memory 不可用时不写。
     * 清空尚待执行（中证据等待确认、软重置、备份进行中）时也不写：重生的证据正是"spawn 不在指纹中、lastRun 早于放置"，
     * 在新实例或下一次判定读到之前更新它们，会使判定改为 NORMAL（附录 C 用例 15）。调用方据此跳过本函数；
     * 本系统 Memory 的清空被闸门拦下后（frozen）同样跳过，理由相同；release 不是证据，由 markRelease 另行写入（审计 DV-10）。
     * 已持久化的模式为 AMBIGUOUS 时不写 fp、lastRun 照常写（审计 DV-03）：AMBIGUOUS 表示资产归属尚未确认，写入 fp 会把
     * 当前 spawn 记进指纹，之后世界回到开局状态时即按 11.4 d 判为 NORMAL，未经确认就认领上一局的 Memory；
     * 这一条件随持久化的模式而定，世界离开开局状态（判定落入"11.7 OURS 保持 AMBIGUOUS"）或 global reset 后同样成立。
     * lastRun 不能冻结：系统实际在运行，冻结会伪造"停运超过 GAP"的证据，使 c′ 改判开局并清空。
     * @param time 当前 tick。
     * @param facts 本 tick 完整判定读取的事实；没有完整判定时为 undefined。
     * @returns 无返回值。
     */
    const maintain = (time: number, facts: BootFacts | undefined): void => {
      const current = marker();
      if (!current || dryRun()) return;
      ctx.sys.set(['lastRun'], time);
      if (current.mode.mode !== 'RECOVERY' && current.mode.mode !== 'AMBIGUOUS' && (facts || time % FP_INTERVAL === 0)) {
        ctx.sys.set(['fp'], fingerprint(facts ?? options.facts()));
      }
    };

    /**
     * @description 每个实例在 Memory 首次就绪时写入一次当前版本号（6.7）。release 不是重生证据，冻结证据时照常写入（审计 DV-10）；
     * 清空尚待执行与 dryRun 时不写，与其他字段一致。
     * @returns 无返回值。
     */
    const markRelease = (): void => {
      if (releaseWritten || dryRun() || marker() === null) return;
      ctx.sys.set(['release'], options.release);
      releaseWritten = true;
    };

    ctx.console.command('assess', 'boot.assess()：读取当前事实完整判定一次，返回模式、强度、情形与证据；不执行、不发布', () => {
      if (!summary) return '本实例尚未运行';
      return describe(assess(options.facts(), memory(), forced));
    });
    ctx.console.command('force', "boot.force(mode)：人工指定模式，下一 tick 生效；boot.force() 取消", (mode?: unknown) => {
      if (mode === undefined) { saveForce(null); rejudge = true; return '已取消人工指定，下一 tick 恢复自动判定'; }
      if (!BOOT_MODES.includes(mode as BootMode)) throw new TypeError(`mode 须为 ${BOOT_MODES.join('、')} 之一`);
      saveForce(mode as BootMode);
      rejudge = true;
      return `已指定 ${String(mode)}，下一 tick 生效`;
    });
    ctx.console.setting('dryRun', 'boot.dryRun：为 true 时只判定与发布模式，不执行任何操作（只存于 heap）', dryRun, (value) => {
      if (typeof value !== 'boolean') throw new TypeError('dryRun 须为布尔值');
      dryRunOverride = value;
      // 下一 tick 重新完整判定（审计 DV-02）：dryRun 期间判定的动作没有执行；不重新判定时，关闭 dryRun 会恢复标记维护，
      // 却不执行闸门，覆盖"lastRun 早于放置"这类重生证据。
      rejudge = true;
    });

    return {
      /**
       * @description 每 tick 的启动判定（11.1）：不变量突变或需要时完整判定，之后维护项目标记。
       * @returns 无返回值。
       */
      boot() {
        const time = options.time();
        summary ??= ctx.port.summary();
        const ready = marker() !== null;
        if (ready) syncForce();
        const now = options.counts();
        const full = counts === undefined || rejudge || ready !== wasReady || mutated(counts, now);
        counts = now;
        let facts: BootFacts | undefined;
        let paused = false;
        let hold = false;
        if (full) ({ facts, paused, hold } = judge(time));
        if (!hold) markRelease();
        if (!hold && !frozen) maintain(time, facts);
        wasReady = marker() !== null;
        if (wasReady) syncForce();
        if (wasReady && !paused) ranUnpaused = true;
      },
    };
  },
});
