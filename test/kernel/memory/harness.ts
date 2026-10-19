/** Memory 集成测试宿主：沿用严格平台替身，传播用户 tick 异常，避免假阳性。 */
import type { ProjectMarker } from '@/contracts/boot';
import type { UnitSpec } from '@/contracts/memory';
import { createMemory, type TickFacts } from '@/kernel/memory';
import { createMemoryPlatform } from '../../platform/memory';

export const marker: ProjectMarker = {
  sig: 'leviathan', schema: 1, shard: 'x', epoch: 0, lastRun: 1, release: 'test',
  fp: { rooms: [], spawnIds: [], creepCount: 0 },
  mode: { mode: 'FRESH_START', strength: 'strong', since: 1, evidence: [] },
};
export type Data = { n: number; nested: { value: string }; list: number[]; optional?: { value: number } };
export const spec: UnitSpec<Data> = {
  version: 1,
  /**
   * @description 生成测试单元的初始数据。
   * @returns 固定的初始数据，测试据此断言落盘内容。
   */
  initialize: () => ({ n: 0, nested: { value: '初始' }, list: [1, 2] }),
  /**
   * @description 测试规格只有版本 1，任何迁移请求都说明测试构造有误。
   * @returns 不返回。
   * @throws {Error} 总是抛出"未声明迁移"。
   */
  migrate: () => { throw new Error('未声明迁移'); },
};
/**
 * @description 创建 Memory 集成测试宿主：严格平台替身、可观测的 read/write/warn 端口，以及按 tick 驱动的入口。
 * @param text 初始的 Memory 原始文本，默认为空串。
 * @param auditUnits 开发期每次提交抽查的未标脏单元数，默认 0（关闭）。
 * @returns 平台替身、端口 mock、tick 驱动、当前 Memory 实例与模拟 global reset 的 reset。
 */
export const harness = (text = '', auditUnits = 0) => {
  const target = {} as { RawMemory: RawMemory; Memory: unknown };
  const platform = createMemoryPlatform({ target, memory: text });
  const write = jest.fn((value: string) => target.RawMemory.set(value));
  const read = jest.fn(() => target.RawMemory.get());
  const warn = jest.fn();
  /**
   * @description 按固定身份与本宿主的平台端口创建 Memory 实例。
   * @returns 新的 Memory 宿主能力集合。
   */
  const create = () => createMemory({ namespace: 'leviathan', signature: 'leviathan', schema: 1,
    auditUnits, platform: { target, read, write, warn } });
  let memory = create();
  /**
   * @description 驱动一个 tick：先 beginTick，再运行测试代码；把用户代码异常重新抛出，避免回调内的断言失败被吞掉。
   * @param time 本 tick 的 Game.time。
   * @param run 本 tick 内执行的测试代码。
   * @param facts 覆盖默认 creep/flag/房间事实的部分事实，默认 creep 与 flag 为空集合。
   * @returns 无返回值。
   * @throws {*} 测试代码或 Memory 抛出的异常原样传播；平台收尾失败抛 PlatformError。
   */
  const tick = (time: number, run: () => void, facts: Partial<Omit<TickFacts, 'time'>> = {}) => {
    const result = platform.tick(() => {
      memory.beginTick({ time, creeps: new Set(), flags: new Set(), ...facts });
      run();
    });
    if (result.error !== undefined) throw result.error;
  };
  return { target, platform, write, read, warn, tick,
    /**
     * @description 取得当前 Memory 实例；reset 后返回新实例。
     * @returns 当前 Memory 宿主能力集合。
     */
    get memory() { return memory; },
    /**
     * @description 模拟 global reset：销毁旧实例并创建新实例，平台持久文本保留。
     * @returns 无返回值。
     */
    reset() { memory.dispose(); memory = create(); },
  };
};
