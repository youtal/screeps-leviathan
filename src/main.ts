/**
 * 文件摘要：游戏入口，导出 Screeps 每 tick 调用的 `loop`，在正常循环与保底循环之间切换
 * （架构设计 5.7，内核设计 docs/design/kernel/README.md 第 6 节）。
 *
 * 所属位置：src/main.ts，构建入口（rollup.config.mjs 的 input）。
 * 每 tick：先接管全局 Memory（使引擎内部写入只落在临时对象上，保底循环的 spawnCreep 也依赖这一点）；
 * 处于停用冷却期时只运行保底循环；否则运行 kernel，抛错时丢弃实例、下一 tick 重新装配，本 tick 改由保底循环运行；
 * 连续 KERNEL_CRASH_LIMIT 次抛错后停用正常循环 KERNEL_COOLDOWN tick；连续 SAFE_MODE_TICKS 个 tick 处于 degraded 时，
 * 在正常循环之后追加保底循环，直到恢复。CPU 硬终止无法被 catch 接管，计数只统计可捕获的异常。
 * 状态：kernel 实例、连续抛错与 degraded 计数、冷却截止 tick 保存在 createEntry 的闭包中（heap），global reset 后重新计数。
 * 切换逻辑写成 createEntry(deps)，测试以假依赖驱动；loop 由游戏依赖创建，模块加载时不读取 Game。
 */
import { type GameServices, assemble, createGameServices } from '@/app/assembly';
import { runFallback } from '@/fallback';
import type { Kernel } from '@/kernel/lifecycle';
import { takeoverMemory } from '@/kernel/memory';

/** 连续处于 degraded 的 tick 数达到此值后，追加运行保底循环。 */
export const SAFE_MODE_TICKS = 3;
/** kernel 连续抛出可捕获异常的次数上限，达到后停用正常循环。 */
export const KERNEL_CRASH_LIMIT = 3;
/** 停用冷却期（tick），期间只运行保底循环。 */
export const KERNEL_COOLDOWN = 100;

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
   * @returns kernel 实例。
   */
  assemble(): Kernel;
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
 * @returns 每 tick 调用一次的 loop 函数。
 */
export const createEntry = (deps: EntryDeps): (() => void) => {
  let kernel: Kernel | undefined;
  let crashes = 0;
  let degraded = 0;
  let cooldownUntil = Number.NEGATIVE_INFINITY;

  return () => {
    try { deps.takeover(); } catch (error) { deps.report('Memory 接管失败，引擎内部写入可能落到真实 Memory', error); }
    let fallback = false;
    if (deps.time() < cooldownUntil) {
      fallback = true;
    } else {
      try {
        kernel ??= deps.assemble();
        const health = kernel.tick();
        crashes = 0;
        degraded = health === 'degraded' ? degraded + 1 : 0;
        fallback = degraded >= SAFE_MODE_TICKS;
      } catch (error) {
        deps.report('正常循环抛错，本 tick 改由保底循环运行；下一 tick 重新装配', error);
        try { kernel?.dispose(); } catch { /* 实例可能已不一致，清理失败不再处理。 */ }
        kernel = undefined;
        degraded = 0;
        crashes += 1;
        fallback = true;
        if (crashes >= KERNEL_CRASH_LIMIT) {
          // 抛错的这个 tick 之后整整 KERNEL_COOLDOWN 个 tick 只运行保底循环。
          cooldownUntil = deps.time() + KERNEL_COOLDOWN + 1;
          crashes = 0;
          deps.report(`正常循环连续 ${KERNEL_CRASH_LIMIT} 次抛错，停用 ${KERNEL_COOLDOWN} tick，期间只运行保底循环`);
        }
      }
    }
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
     * @description 用游戏服务装配新的 kernel。
     * @returns kernel 实例。
     */
    assemble: () => assemble(get()),
    fallback: runFallback,
    /**
     * @description 当前 tick。
     * @returns Game.time。
     */
    time: () => Game.time,
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

/** Screeps 每 tick 调用的入口。 */
export const loop = createEntry(gameEntryDeps());
