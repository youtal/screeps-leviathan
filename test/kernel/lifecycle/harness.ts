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
 * @returns kernel、日志行、平台替身与按 tick 驱动的函数。
 */
export const kernelHarness = (options: { modules: ModuleDefinition[]; boot?: BootDefinition; memory?: string }) => {
  const target = {} as { Memory: unknown; RawMemory: RawMemory };
  const platform = createMemoryPlatform({ target, memory: options.memory ?? READY_MEMORY });
  const lines: string[] = [];
  let time = 0;
  const logRoot = createLogRoot({ sink: (l) => lines.push(l), time: () => time, format: (e) => String(e),
    levels: { debug: false, info: true, success: true, warn: true, error: true } });
  const kernel: Kernel = createKernel({
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
      creepNames: () => new Set(), flagNames: () => new Set() },
    logRoot,
    profiler: createProfiler({ cpuUsed: () => 0 }),
  });
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
  return { kernel, lines, platform, tick };
};
