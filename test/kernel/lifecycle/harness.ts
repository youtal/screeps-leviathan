/**
 * 文件摘要：kernel.lifecycle 测试宿主：以 Memory 平台替身与假 GamePort 驱动 createKernel，记录日志与钩子调用。
 */
import type { ProjectMarker } from '@/contracts/boot';
import type { BootDefinition } from '@/contracts/boot';
import type { ModuleDefinition } from '@/contracts/module';
import { type Kernel, createKernel } from '@/kernel/lifecycle';
import { createLogRoot } from '@/kernel/logger';
import { createProfiler } from '@/kernel/profiler';
import { createMemoryPlatform } from '../../platform/memory';

export const marker: ProjectMarker = {
  sig: 'leviathan', schema: 1, shard: 'x', epoch: 0, lastRun: 1, release: 'test',
  fp: { rooms: [], spawnIds: [], creepCount: 0 },
  mode: { mode: 'FRESH_START', strength: 'strong', since: 1, evidence: [] },
};

/** 已初始化的 Memory 文本：本项目命名空间与合法的项目标记。 */
export const READY_MEMORY = JSON.stringify({ leviathan: { sys: marker, part: {}, rooms: {}, creeps: {}, flags: {} } });

/**
 * @description 创建 kernel 测试宿主。
 * @param options 宿主参数。
 * @param options.modules 模块清单。
 * @param options.boot boot 定义，默认什么也不做。
 * @param options.memory 初始 Memory 文本，默认已初始化。
 * @param options.segments 平台上已有的 segment 内容。
 * @param options.interShard InterShardMemory 所在的对象，默认不提供 InterShardMemory（与私服一致）。
 * @param options.creeps 每 tick 的 creep 名称集合，默认为空。
 * @returns kernel（rebuild 后为新实例）、日志行、平台替身、全局目标对象、按 tick 驱动的函数与模拟入口重建的 rebuild。
 */
export const kernelHarness = (options: { modules: ModuleDefinition[]; boot?: BootDefinition; memory?: string;
  segments?: Record<number, string>; interShard?: object; creeps?: () => ReadonlySet<string> }) => {
  const target = {} as { Memory: unknown; RawMemory: RawMemory };
  const platform = createMemoryPlatform({ target, memory: options.memory ?? READY_MEMORY, segments: options.segments });
  const lines: string[] = [];
  let time = 0;
  const logRoot = createLogRoot({ sink: (l) => lines.push(l), time: () => time, format: (e) => String(e),
    levels: { debug: false, info: true, success: true, warn: true, error: true } });
  /**
   * @description 用同一平台与选项创建 kernel 实例。
   * @returns 新的 kernel。
   */
  const create = (): Kernel => createKernel({
    modules: options.modules,
    boot: options.boot ?? {
      /**
       * @description 默认 boot：什么也不做。
       * @returns 空的 boot 钩子。
       */
      setup: () => ({
        /**
         * @description 空的 boot 钩子。
         * @returns 无返回值。
         */
        boot: () => undefined,
      }),
    },
    memory: { namespace: 'leviathan', signature: 'leviathan', schema: 1,
      platform: { target, read: () => target.RawMemory.get(), write: (v) => target.RawMemory.set(v), warn: () => undefined } },
    game: { time: () => time, cpuUsed: () => 0, tickLimit: () => 500, limit: () => 20, bucket: () => 10000,
      shard: () => 'x', creepNames: options.creeps ?? (() => new Set()), flagNames: () => new Set() },
    logRoot,
    profiler: createProfiler({ cpuUsed: () => 0 }),
    release: 'test-release',
    segments: {
      /**
       * @description 当前 tick 的 RawMemory.segments。
       * @returns segment 字典。
       */
      segments: () => target.RawMemory.segments as unknown as Record<string, unknown>,
      /**
       * @description 提交激活请求。
       * @param ids 页号。
       * @returns 无返回值。
       */
      setActive: (ids) => target.RawMemory.setActiveSegments([...ids]),
    },
    interShard: options.interShard ?? {},
  });
  let kernel = create();
  /**
   * @description 推进到下一个 tick 并执行 kernel.tick。
   * @returns 本 tick 的健康状态。
   * @throws {*} 平台替身捕获的用户代码异常原样抛出。
   */
  const tick = () => {
    time += 1;
    let health: string | undefined;
    const result = platform.tick(() => { health = kernel.tick(); });
    if (result.error !== undefined) throw result.error;
    return health;
  };
  return { lines, platform, target, tick,
    /**
     * @description 当前 kernel 实例。
     * @returns kernel。
     */
    get kernel() { return kernel; },
    /**
     * @description 模拟入口在软重置后的重建：销毁当前实例，用同一平台创建新实例；heap 状态随旧实例丢弃。
     * @returns 无返回值。
     */
    rebuild() { kernel.dispose(); kernel = create(); },
  };
};
