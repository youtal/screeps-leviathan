/** Memory 集成测试宿主：沿用严格平台替身，传播用户 tick 异常，避免假阳性。 */
import type { ProjectMarker } from '../../../src/contracts/boot';
import type { UnitSpec } from '../../../src/contracts/memory';
import { createMemory, type TickFacts } from '../../../src/kernel/memory';
import { createMemoryPlatform } from '../../platform/memory';

export const marker: ProjectMarker = {
  sig: 'leviathan', schema: 1, shard: 'x', epoch: 0, lastRun: 1, release: 'test',
  fp: { rooms: [], spawnIds: [], creepCount: 0 },
  mode: { mode: 'FRESH_START', strength: 'strong', since: 1, evidence: [] },
};
export type Data = { n: number; nested: { value: string }; list: number[]; optional?: { value: number } };
export const spec: UnitSpec<Data> = {
  version: 1,
  initialize: () => ({ n: 0, nested: { value: '初始' }, list: [1, 2] }),
  migrate: () => { throw new Error('未声明迁移'); },
};
export const harness = (text = '', auditUnits = 0) => {
  const target = {} as { RawMemory: RawMemory; Memory: unknown };
  const platform = createMemoryPlatform({ target, memory: text });
  const write = jest.fn((value: string) => target.RawMemory.set(value));
  const read = jest.fn(() => target.RawMemory.get());
  const warn = jest.fn();
  const create = () => createMemory({ namespace: 'leviathan', signature: 'leviathan', schema: 1,
    auditUnits, platform: { target, read, write, warn } });
  let memory = create();
  const tick = (time: number, run: () => void, facts: Partial<Omit<TickFacts, 'time'>> = {}) => {
    const result = platform.tick(() => {
      memory.beginTick({ time, creeps: new Set(), flags: new Set(), ...facts });
      run();
    });
    if (result.error !== undefined) throw result.error;
  };
  return { target, platform, write, read, warn, tick,
    get memory() { return memory; },
    reset() { memory.dispose(); memory = create(); },
  };
};
