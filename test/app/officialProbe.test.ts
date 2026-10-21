/** 文件摘要：官服夹具的安全边界与真实 kernel 集成测试；覆盖故障自动到期、实例删除与备份/软重置。 */
import { createOfficialProbe, officialProbeEnabled } from '@/app/assembly/officialProbe';
import { createProfiler } from '@/kernel/profiler';
import { kernelHarness } from '../kernel/lifecycle/harness';

/**
 * @description 创建真实 kernel 与官服夹具，Game 只提供夹具需要的对象事实。
 * @returns 测试宿主、命令和逐 tick 驱动。
 */
const fixture = () => {
  const game = { time: 0, shard: { name: 'shard0' }, flags: {} as Record<string, unknown>,
    spawns: { Spawn1: { owner: { username: 'pinkpunk' }, pos: { x: 25, y: 25, roomName: 'W16N8' } } } };
  Object.assign(globalThis, { Game: game });
  const probe = createOfficialProbe(createProfiler({ cpuUsed: () => 0 }));
  const h = kernelHarness({ modules: [...probe.modules], boot: probe.boot({ setup: () => ({ boot: () => undefined }) }),
    game: { flagNames: () => new Set(Object.keys(game.flags)) } });
  probe.install(h.kernel);
  const commands = h.globals.m1 as Record<string, (...args: unknown[]) => string>;
  return { h, game, commands,
    /**
     * @description 同步 Game.time 与宿主时间并执行 tick。
     * @returns kernel 健康状态。
     */
    tick() { game.time += 1; return h.tick(); },
  };
};

afterEach(() => { delete (globalThis as { Game?: unknown }).Game; });

test('只在指定账户与 shard 启用；故障自动恢复且不重新 setup，持久计数持续提交', () => {
  const { h, game, commands, tick } = fixture();
  expect(officialProbeEnabled()).toBe(true);
  game.shard.name = 'shard1';
  expect(officialProbeEnabled()).toBe(false);
  game.shard.name = 'shard0';
  game.spawns.Spawn1.owner.username = 'other';
  expect(officialProbeEnabled()).toBe(false);
  expect(tick()).toBe('ok');
  expect(commands.fault('module', 101)).toContain('错误');
  commands.fault('module', 5);
  expect([tick(), tick(), tick(), tick(), tick(), tick()]).toEqual(['ok', 'ok', 'degraded', 'degraded', 'degraded', 'ok']);
  const state = JSON.parse(commands.status());
  expect(state).toMatchObject({ setups: 1, recovered: 1, fault: null, phase: 'sense>plan>arbitrate>act>move', persisted: { ticks: 7, last: 7 } });
  expect(JSON.parse(h.platform.memory).leviathan.part.m1Probe.state.data).toEqual({ ticks: 7, last: 7 });
  h.kernel.dispose();
});

test('实例熔断不降级，删除旗帜取消故障，定时恢复不会访问已删除实例', () => {
  const { h, game, commands, tick } = fixture();
  game.flags['m1-check'] = {};
  expect(tick()).toBe('ok');
  commands.fault('instance', 5);
  expect([tick(), tick(), tick()]).toEqual(['ok', 'ok', 'ok']);
  expect(h.kernel.ops.status().modules.find((m) => m.id === 'm1Economy')?.brokenInstances).toBe(1);
  delete game.flags['m1-check'];
  expect([tick(), tick(), tick(), tick()]).toEqual(['ok', 'ok', 'ok', 'ok']);
  expect(JSON.parse(commands.status())).toMatchObject({ activeInstance: false, disposals: 1, fault: null });
  h.kernel.dispose();
});

test('备份完成后保持项目 epoch；软重置通过真实 bootPort 请求', () => {
  const { h, commands, tick } = fixture();
  tick();
  commands.backup();
  for (let i = 0; i < 8; i += 1) tick();
  expect(JSON.parse(commands.status()).backup).toBe('done');
  expect(JSON.parse(h.platform.memory).leviathan.sys.epoch).toBe(0);
  commands.reset();
  expect(tick()).toBe('paused');
  expect(h.kernel.resetRequested()).toBe(true);
  h.kernel.dispose();
});
