/**
 * 文件摘要：游戏入口，导出 Screeps 每 tick 调用的 `loop`，在正常循环与保底循环之间切换
 * （架构设计 5.7，内核设计 docs/design/kernel/README.md 第 6 节）。
 *
 * 所属位置：src/main.ts，构建入口（rollup.config.mjs 的 input）。
 * 每 tick：先接管全局 Memory（使引擎内部写入只落在临时对象上，保底循环的 spawnCreep 也依赖这一点）；
 * 处于停用冷却期时只运行保底循环；否则运行 kernel，抛错时丢弃实例、下一 tick 重新装配，本 tick 改由保底循环运行；
 * 连续 KERNEL_CRASH_LIMIT 次失败（kernel 抛错、上一 tick 被 CPU 硬终止，或连续暂停超过 PAUSE_LIMIT 后仍登记软重置）后停用正常循环 KERNEL_COOLDOWN tick；
 * 连续 SAFE_MODE_TICKS 个 tick 计为 degraded 时，在正常循环之后追加保底循环，直到恢复。
 * CPU 硬终止（内核设计第 6 节）：终止不执行 catch 与 finally，公开 driver 在超时后保留 VM 与 heap，下一 tick 继续调用同一个 loop。
 * 入口在装配与 kernel.tick 期间置 running，正常结束或进入 catch 时清除；下一 tick 发现它仍为 true，说明上一 tick 被终止，
 * kernel 可能停在任意中间状态：丢弃实例，按一次失败计数，本 tick 运行保底，下一 tick 从已提交的文本重新装配
 * （被终止的 tick 不保存 Memory 与 segment，重建得到的就是终止前的持久状态；审计 S-01–S-06）。
 * 软重置：boot 登记后 tick 正常结束时销毁 kernel，下一 tick 重新装配；连续暂停未超过 PAUSE_LIMIT 时不计为失败。
 * boot 抛错的 tick 登记的软重置已由 kernel 作废，不会到达这里（docs/design/kernel/bootPort.md 第 3 节）。
 * 暂停 tick（paused）不改变 degraded 计数，使开局备份期间保底循环不会抢先孵化；连续暂停超过 PAUSE_LIMIT 后
 * 按 degraded 计数，保证 boot 卡在暂停时保底循环最终仍能接管（内核设计第 6 节）。超限后再登记的软重置按一次失败
 * 与抛错共用计数和冷却，避免 boot 陷入重置循环时每 tick 重新装配并解析 Memory；超限期间失败计数不清零。
 * 接管通知（13.4，审计 LC-07）：保底循环在本 tick 运行、而上一 tick 没有运行时视为接管开始，经 Game.notify 发出纯文本通知；
 * 距上次通知不足 FALLBACK_NOTIFY_GAP 时不再通知。入口状态（审计 LC-04）：经 entryStatus() 交给装配方，
 * kernel 不可用时 ops.status() 以它说明正常循环为什么没在运行。
 * 状态：kernel 实例、本 tick 是否在运行 kernel、连续失败、degraded 与暂停计数、冷却截止 tick、最近一次失败、上一 tick 是否运行保底与上次通知的 tick
 * 保存在 createEntry 的闭包中（heap），跨软重置累计，global reset 或模块重新执行后重新计数。
 * 模块重新执行（内核设计第 6 节）：代码更新而 global 未重置时，引擎在同一个 global 中重新执行 main
 * （@screeps/engine src/game/game.js），模块作用域里的状态随之重建：入口重新创建，kernel 从已提交的持久状态重新装配，
 * 与 global reset 相同；上一轮安装的控制台命名空间由 kernel.console 识别并替换。入口不在全局对象上登记状态。
 * 切换逻辑写成 createEntry(deps)，测试以假依赖驱动；模块加载时只创建入口，不读取 Game。
 */
import { type GameServices, assemble, createGameServices } from '@/app/assembly';
import type { EntryStatus } from '@/app/ops';
import { runFallback } from '@/fallback';
import type { Kernel } from '@/kernel/lifecycle';
import { takeoverMemory } from '@/kernel/memory';

/** 连续处于 degraded 的 tick 数达到此值后，追加运行保底循环。 */
export const SAFE_MODE_TICKS = 3;
/** 连续失败的次数上限，达到后停用正常循环；失败指 kernel 抛出可捕获异常，或连续暂停超过 PAUSE_LIMIT 后仍登记软重置。 */
export const KERNEL_CRASH_LIMIT = 3;
/** 停用冷却期（tick），期间只运行保底循环。 */
export const KERNEL_COOLDOWN = 100;
/** 连续暂停 tick 的上限，跨软重置累计；备份一次重写加软重置最多约 7 tick。 */
export const PAUSE_LIMIT = 10;
/** 两次"保底循环接管"通知之间的最小间隔（tick）。 */
export const FALLBACK_NOTIFY_GAP = 1000;
/** 最近一次失败说明的长度上限（字符）。 */
const FAILURE_TEXT_LIMIT = 200;

/** 入口的外部依赖，游戏中由 gameEntryDeps 提供。 */
export interface EntryDeps {
  /**
   * @description 接管全局 Memory。
   * @returns 无返回值。
   * @throws {Error} 接管过晚。
   */
  takeover(): void;
  /**
   * @description 装配一个新的 kernel。
   * @param entryStatus 入口状态的读取函数，供 app.ops 在 kernel 不可用时使用。
   * @returns kernel 实例。
   */
  assemble(entryStatus: () => EntryStatus): Kernel;
  /**
   * @description 运行保底循环。
   * @returns 无返回值。
   */
  fallback(): void;
  /**
   * @description 当前 tick。
   * @returns Game.time。
   */
  time(): number;
  /**
   * @description 发出游戏通知（Game.notify），用于保底循环接管的告警。
   * @param message 纯文本正文。
   * @returns 无返回值。
   * @throws {*} 平台拒绝时可能抛错，由入口记录。
   */
  notify(message: string): void;
  /**
   * @description 报告入口层面的故障。
   * @param message 说明。
   * @param error 可选的抛出值。
   * @returns 无返回值；不得抛错。
   */
  report(message: string, error?: unknown): void;
}

/**
 * @description 创建每 tick 调用的入口函数，在闭包中保存 kernel 实例与故障计数。
 * @param deps 外部依赖。
 * @returns 每 tick 调用一次的入口。
 */
export const createEntry = (deps: EntryDeps): (() => void) => {
  let kernel: Kernel | undefined;
  // 装配或 kernel.tick 正在进行：进入 try 时置 true，try 正常走完或进入 catch 时清除。CPU 硬终止不执行 catch，
  // 所以下一 tick 开始时仍为 true 即说明上一 tick 被终止；只在 heap 中，global reset 后为 false（没有可沿用的实例）。
  let running = false;
  let crashes = 0;
  let degraded = 0;
  let paused = 0;
  let cooldownUntil = Number.NEGATIVE_INFINITY;
  // 最近一次失败：tick 与说明（错误消息的第一行，截短）；供 ops.status 在 kernel 不可用时显示。
  let lastFailure: EntryStatus['lastFailure'];
  // 上一 tick 是否运行了保底循环，用于识别接管开始；上次发出接管通知的 tick。
  let fallbackBefore = false;
  let notifiedAt = Number.NEGATIVE_INFINITY;

  /**
   * @description 读取入口状态，语义见 EntryStatus；跨 kernel 实例存在，不引用 kernel。
   * @returns 入口状态。
   */
  const entryStatus = (): EntryStatus => {
    const time = deps.time();
    return { time, cooldown: Math.max(0, cooldownUntil - time), crashes, degraded, paused, lastFailure };
  };

  /**
   * @description 记录最近一次失败。它在入口最外层的 catch 中调用，自身不得抛错：抛出值可能是无原型对象、
   * toString 抛错的对象，或 message 读取抛错、不是字符串的 Error，转文本失败时以固定文本代替（ultrareview 第 6 项），
   * 否则 catch 的其余步骤（清理实例、计数、转保底）会被跳过，异常逃出 loop。
   * @param message 说明。
   * @param error 可选的抛出值，取其消息的第一行。
   * @returns 无返回值。
   */
  const recordFailure = (message: string, error?: unknown): void => {
    let detail = '';
    if (error !== undefined) {
      try {
        detail = `：${String(error instanceof Error ? error.message : error).split('\n')[0]}`;
      } catch {
        detail = '：（无法转为文本的抛出值）';
      }
    }
    lastFailure = { tick: deps.time(), message: `${message}${detail}`.slice(0, FAILURE_TEXT_LIMIT) };
  };

  /**
   * @description 保底接管开始时发出通知；距上次通知不足 FALLBACK_NOTIFY_GAP 时不发。通知失败只报告。
   * @param reason 接管原因。
   * @returns 无返回值。
   */
  const notifyTakeover = (reason: string): void => {
    const time = deps.time();
    if (time - notifiedAt < FALLBACK_NOTIFY_GAP) return;
    notifiedAt = time;
    try { deps.notify(`tick ${time}：保底循环接管（${reason}）`); } catch (error) { deps.report('保底接管通知发送失败', error); }
  };

  /**
   * @description 计入一次失败（kernel 抛错、上一 tick 被硬终止，或连续暂停超过上限后 boot 仍登记软重置）；连续达到
   * KERNEL_CRASH_LIMIT 次时进入停用冷却并清零计数。每类失败都会使下一 tick 重新装配并完整解析 Memory；持续失败时，
   * 冷却把这项成本限制为每 KERNEL_CRASH_LIMIT + KERNEL_COOLDOWN tick 至多 KERNEL_CRASH_LIMIT 次（审计 S-24）。
   * @returns 无返回值；达到上限时设置冷却截止 tick 并报告。
   */
  const countCrash = (): void => {
    crashes += 1;
    if (crashes < KERNEL_CRASH_LIMIT) return;
    // 本 tick 之后整整 KERNEL_COOLDOWN 个 tick 只运行保底循环。
    cooldownUntil = deps.time() + KERNEL_COOLDOWN + 1;
    crashes = 0;
    deps.report(`正常循环连续 ${KERNEL_CRASH_LIMIT} 次失败，停用 ${KERNEL_COOLDOWN} tick，期间只运行保底循环`);
  };

  /**
   * @description 处理上一 tick 的硬终止：丢弃可能停在任意中间状态的实例，按一次失败计数。先清除标记与引用再清理，
   * 清理本身再被终止时，下一 tick 也不会重复处理同一个实例。
   * @returns 无返回值；kernel 置为 undefined，degraded 清零，记录失败并计数。
   */
  const discardTerminated = (): void => {
    running = false;
    const stale = kernel;
    kernel = undefined;
    degraded = 0;
    deps.report('上一 tick 未正常结束（CPU 硬终止），丢弃 kernel 实例，本 tick 改由保底循环运行；下一 tick 重新装配');
    recordFailure('上一 tick 未正常结束（CPU 硬终止）');
    try { stale?.dispose(); } catch (error) { deps.report('丢弃被终止的 kernel 时清理失败', error); }
    countCrash();
  };

  /**
   * @description 每 tick 的入口流程，语义见文件摘要。
   * @returns 无返回值。
   */
  return (): void => {
    try { deps.takeover(); } catch (error) { deps.report('Memory 接管失败，引擎内部写入可能落到真实 Memory', error); }
    let fallback = false;
    let reason = '停用冷却';
    if (running) {
      // 与抛错相同：本 tick 只运行保底，下一 tick 再装配，不在同一 tick 内重复成本最高的装配与解析。
      discardTerminated();
      fallback = true;
      reason = '上一 tick 被硬终止';
    } else if (deps.time() < cooldownUntil) {
      fallback = true;
    } else {
      try {
        running = true;
        kernel ??= deps.assemble(entryStatus);
        const health = kernel.tick();
        // 未超过上限的暂停 tick 既不计数也不运行保底：备份期间保底孵化会破坏开局证据（11.4）。
        const counted = health !== 'paused' || (paused += 1) > PAUSE_LIMIT;
        if (health !== 'paused') paused = 0;
        if (counted) degraded = health === 'ok' ? 0 : degraded + 1;
        fallback = counted && degraded >= SAFE_MODE_TICKS;
        reason = health === 'paused' ? '连续暂停超限' : '连续 degraded';
        // 超限的暂停 tick 不是恢复的证据，不清零失败计数；否则软重置与普通暂停交替就能绕过冷却。
        const overLimit = health === 'paused' && paused > PAUSE_LIMIT;
        if (!overLimit) crashes = 0;
        if (kernel.resetRequested()) {
          // 软重置：本 tick 已完成并提交；丢弃全部进程实例与 heap 缓存，下一 tick 从已提交的文本重新装配。
          try { kernel.dispose(); } catch (error) { deps.report('软重置时 kernel 清理失败', error); }
          kernel = undefined;
          // 正常开局流程最多约 7 个暂停 tick；超限后仍登记软重置说明 boot 陷入重置循环，按失败计数以进入冷却。
          if (overLimit) {
            deps.report(`连续暂停超过 ${PAUSE_LIMIT} tick 后 boot 仍登记软重置，按一次失败计数`);
            recordFailure('暂停超限后仍登记软重置');
            countCrash();
          }
        }
        // 软重置的清理也在检测范围内：清理被终止时同样丢弃实例，而不是在下一 tick 调用已部分销毁的 kernel。
        running = false;
      } catch (error) {
        running = false;
        deps.report('正常循环抛错，本 tick 改由保底循环运行；下一 tick 重新装配', error);
        recordFailure('正常循环抛错', error);
        try { kernel?.dispose(); } catch { /* 实例可能已不一致，清理失败不再处理。 */ }
        kernel = undefined;
        degraded = 0;
        fallback = true;
        reason = '正常循环抛错';
        countCrash();
      }
    }
    if (fallback && !fallbackBefore) notifyTakeover(reason);
    fallbackBefore = fallback;
    if (fallback) {
      try { deps.fallback(); } catch (error) { deps.report('保底循环抛错', error); }
    }
  };
};

/**
 * @description 游戏环境的入口依赖；游戏服务在首次需要时创建并缓存于闭包，模块加载时不读取 Game。
 * @returns 入口依赖。
 */
const gameEntryDeps = (): EntryDeps => {
  let services: GameServices | undefined;
  /**
   * @description 取得（必要时创建）游戏服务。
   * @returns 游戏服务。
   */
  const get = (): GameServices => { services ??= createGameServices(); return services; };
  return {
    /**
     * @description 接管游戏全局 Memory。
     * @returns 无返回值。
     * @throws {Error} 接管过晚。
     */
    takeover: () => takeoverMemory(globalThis),
    /**
     * @description 用游戏服务装配新的 kernel，并创建其运维命令。
     * @param entryStatus 入口状态的读取函数。
     * @returns kernel 实例。
     */
    assemble: (entryStatus) => assemble(get(), entryStatus),
    fallback: runFallback,
    /**
     * @description 当前 tick。
     * @returns Game.time。
     */
    time: () => Game.time,
    /**
     * @description 发出游戏通知。
     * @param message 纯文本正文。
     * @returns 无返回值。
     */
    notify: (message) => Game.notify(message),
    /**
     * @description 经 main 作用域的日志报告故障；日志不可用时退回 console.log。
     * @param message 说明。
     * @param error 可选的抛出值。
     * @returns 无返回值；不抛错。
     */
    report: (message, error) => {
      try {
        get().logRoot.scope('main').error(message, error);
      } catch {
        console.log(`[main] ${message}`);
      }
    },
  };
};

/** Screeps 每 tick 调用的入口；模块每执行一次创建一个。 */
export const loop = createEntry(gameEntryDeps());
