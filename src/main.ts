/**
 * 文件摘要：游戏入口，导出 Screeps 每 tick 调用的 `loop`，在正常循环与保底循环之间切换
 * （架构设计 5.7，内核设计 docs/design/kernel/README.md 第 6 节）。
 *
 * 所属位置：src/main.ts，构建入口（rollup.config.mjs 的 input）。
 * 每 tick：先接管全局 Memory（使引擎内部写入只落在临时对象上，保底循环的 spawnCreep 也依赖这一点）；
 * 处于停用冷却期时只运行保底循环；否则运行 kernel，抛错时丢弃实例、下一 tick 重新装配，本 tick 改由保底循环运行；
 * 连续 KERNEL_CRASH_LIMIT 次失败（kernel 抛错，或连续暂停超过 PAUSE_LIMIT 后仍登记软重置）后停用正常循环 KERNEL_COOLDOWN tick；
 * 连续 SAFE_MODE_TICKS 个 tick 计为 degraded 时，在正常循环之后追加保底循环，直到恢复。
 * CPU 硬终止无法被 catch 接管，失败计数只统计可捕获的异常与超限的软重置。
 * 软重置：boot 登记后 tick 正常结束时销毁 kernel，下一 tick 重新装配；连续暂停未超过 PAUSE_LIMIT 时不计为失败。
 * boot 抛错的 tick 登记的软重置已由 kernel 作废，不会到达这里（docs/design/kernel/bootPort.md 第 3 节）。
 * 暂停 tick（paused）不改变 degraded 计数，使开局备份期间保底循环不会抢先孵化；连续暂停超过 PAUSE_LIMIT 后
 * 按 degraded 计数，保证 boot 卡在暂停时保底循环最终仍能接管（内核设计第 6 节）。超限后再登记的软重置按一次失败
 * 与抛错共用计数和冷却，避免 boot 陷入重置循环时每 tick 重新装配并解析 Memory；超限期间失败计数不清零。
 * 接管通知（13.4，审计 LC-07）：保底循环在本 tick 运行、而上一 tick 没有运行时视为接管开始，经 Game.notify 发出纯文本通知；
 * 距上次通知不足 FALLBACK_NOTIFY_GAP 时不再通知。入口状态（审计 LC-04）：经 entryStatus() 交给装配方，
 * kernel 不可用时 ops.status() 以它说明正常循环为什么没在运行。
 * 状态：kernel 实例、连续失败、degraded 与暂停计数、冷却截止 tick、最近一次失败、上一 tick 是否运行保底与上次通知的 tick
 * 保存在 createEntry 的闭包中（heap），跨软重置累计，global reset 后重新计数。
 * 模块重新执行（内核设计第 6 节）：引擎在 require.cache.main 失效或代码时间戳变化时，会在同一个 global 中重新执行
 * main（@screeps/engine src/game/game.js），模块作用域里的状态随之重建。入口因此登记在全局注册表 globalThis[ENTRY_KEY]：
 * 同一构建（assembly 的 BUILD）的重新执行沿用已有入口，kernel 与跨 tick 的流程（如开局备份）得以延续；构建不同时
 * 先销毁旧入口的 kernel（卸下控制台命名空间）再新建。重新执行的次数在 1、10、100…… 次时各记录一条 info。
 * 切换逻辑写成 createEntry(deps)，测试以假依赖驱动；loop 由 resolveEntry 取得，模块加载时只读写 globalThis，不读取 Game。
 */
import { BUILD, type GameServices, assemble, createGameServices } from '@/app/assembly';
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
  /**
   * @description 记录入口层面的一般信息（info 级），例如模块的重新执行。
   * @param message 说明。
   * @returns 无返回值；不得抛错。
   */
  notice(message: string): void;
}

/** 入口：每 tick 调用的 loop，附带供全局注册表使用的方法。 */
export interface EntryLoop {
  /**
   * @description 每 tick 调用一次。
   * @returns 无返回值。
   */
  (): void;
  /**
   * @description 同一 global 中 main 模块重新执行、沿用本入口时调用：累计次数，下一次 loop 时按 1、10、100…… 限频记录 info。
   * @returns 无返回值。
   */
  reevaluated(): void;
  /**
   * @description 代码更新后丢弃本入口：销毁 kernel（卸下控制台命名空间）；之后再调用 loop 不做任何事。
   * @returns 无返回值；不抛错。
   */
  dispose(): void;
}

/** 全局注册表的键。Symbol.for 在同一 global 中返回同一个符号，各轮模块执行都能找到同一条记录。 */
export const ENTRY_KEY = Symbol.for('leviathan.entry');

/** 全局注册表中的入口记录：创建它的构建标识与入口。 */
interface EntryRecord {
  readonly build: string;
  readonly loop: EntryLoop;
}

/**
 * @description 取得本次模块执行使用的入口（内核设计第 6 节"模块重新执行"）。同一 global 中已有同一构建的入口时沿用，
 * 使 kernel 与跨 tick 的流程不因模块重新执行而中断；构建不同（代码更新）时先销毁旧入口再新建；没有时新建并登记。
 * @param target 登记入口的全局对象，游戏中为 globalThis。
 * @param build 当前构建的标识。
 * @param create 新建入口的函数；只在不能沿用时调用。
 * @returns 入口。
 */
export const resolveEntry = (target: object, build: string, create: () => EntryLoop): EntryLoop => {
  const registry = target as Record<symbol, unknown>;
  const existing = registry[ENTRY_KEY] as Partial<EntryRecord> | undefined;
  if (existing?.build === build && typeof existing.loop === 'function') {
    existing.loop.reevaluated();
    return existing.loop;
  }
  if (typeof existing?.loop?.dispose === 'function') existing.loop.dispose();
  const loop = create();
  Object.defineProperty(target, ENTRY_KEY, { value: { build, loop } satisfies EntryRecord, configurable: true, writable: true, enumerable: false });
  return loop;
};

/**
 * @description 创建每 tick 调用的入口函数，在闭包中保存 kernel 实例与故障计数。
 * @param deps 外部依赖。
 * @returns 每 tick 调用一次的入口，附带 reevaluated 与 dispose。
 */
export const createEntry = (deps: EntryDeps): EntryLoop => {
  let kernel: Kernel | undefined;
  // 同一 global 中模块重新执行、沿用本入口的累计次数；达到 nextNotice 时记录一次，之后阈值乘 10。
  let reevaluations = 0;
  let nextNotice = 1;
  // 已被新构建的入口取代：不再运行。
  let disposed = false;
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
   * @description 计入一次失败（kernel 抛错，或连续暂停超过上限后 boot 仍登记软重置）；连续达到 KERNEL_CRASH_LIMIT 次时
   * 进入停用冷却并清零计数。两类失败都会使下一 tick 重新装配并完整解析 Memory，冷却把这项成本限制在每 KERNEL_COOLDOWN tick 一次。
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
   * @description 每 tick 的入口流程，语义见文件摘要。
   * @returns 无返回值。
   */
  const loop = (): void => {
    if (disposed) return;
    try { deps.takeover(); } catch (error) { deps.report('Memory 接管失败，引擎内部写入可能落到真实 Memory', error); }
    if (reevaluations >= nextNotice) {
      deps.notice(`main 模块在同一 global 中重新执行（累计 ${reevaluations} 次），沿用已有的入口与 kernel`);
      while (nextNotice <= reevaluations) nextNotice *= 10;
    }
    let fallback = false;
    let reason = '停用冷却';
    if (deps.time() < cooldownUntil) {
      fallback = true;
    } else {
      try {
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
      } catch (error) {
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

  return Object.assign(loop, {
    /**
     * @description 记录一次沿用本入口的模块重新执行，语义见 EntryLoop.reevaluated。
     * @returns 无返回值。
     */
    reevaluated: (): void => { reevaluations += 1; },
    /**
     * @description 销毁本入口的 kernel，语义见 EntryLoop.dispose。
     * @returns 无返回值；kernel 清理失败只报告。
     */
    dispose: (): void => {
      disposed = true;
      try { kernel?.dispose(); } catch (error) { deps.report('代码更新时旧入口的 kernel 清理失败', error); }
      kernel = undefined;
    },
  });
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
    /**
     * @description 经 main 作用域的日志记录 info；日志不可用时退回 console.log。
     * @param message 说明。
     * @returns 无返回值；不抛错。
     */
    notice: (message) => {
      try {
        get().logRoot.scope('main').info(message);
      } catch {
        console.log(`[main] ${message}`);
      }
    },
  };
};

/** Screeps 每 tick 调用的入口；同一 global 中重新执行 main 时沿用同一构建已登记的入口。 */
export const loop = resolveEntry(globalThis, BUILD, () => createEntry(gameEntryDeps()));
