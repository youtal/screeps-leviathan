/**
 * 文件摘要：在真实 Screeps 4.3 引擎中装载正式 Rollup 产物并验证连续 tick。
 *
 * 场景从 dist/main.js 与 sourcemap 构造玩家模块，只在内存中的 main 模块末尾追加执行计数器；
 * 仓库产物本身不会被改写。计数器驻留玩家 isolate 的 global heap，用于证明生产 loop 确实被
 * 引擎连续调用，同时不向 Memory 写入测试字段，也不绕过项目的 MemoryManager 访问边界。
 * 装载、断言口径与失败现场由 `../support/harness.js` 统一提供，场景结束必定 dispose。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const {
  assertRuntimeClean,
  loadProductionModules,
  withWorld,
} = require('../support/harness.js');

const ROOM_NAME = 'W0N1';
const BOT_NAME = 'leviathan';
const TICKS = 3;

/**
 * 构建一间最小可见房：bot 拥有 RCL1 控制器与 Spawn，真实 Game、CPU 计量和 Room 查询
 * 因而可用。查询探针通过玩家 console 在下一 tick 执行，返回 isolate 内部状态。
 */
async function run() {
  return withWorld(
    {
      rooms: [
        {
          name: ROOM_NAME,
          controller: spec.controller({ level: 1 }),
          sources: [spec.source(10, 10), spec.source(40, 40)],
          structures: [spec.spawn(25, 25, { name: 'Spawn1' })],
        },
      ],
      bots: [
        {
          username: BOT_NAME,
          rooms: ROOM_NAME,
          modules: loadProductionModules(),
        },
      ],
      logLevel: 'all',
    },
    async (world) => {
      await world.tick(TICKS);

      const probePromise = world.evalInBot(
        `JSON.stringify({
          runs: globalThis.__leviathanIntegrationRuns,
          lastTick: globalThis.__leviathanIntegrationLastTick,
          gameTime: Game.time,
          roomVisible: Boolean(Game.rooms.${ROOM_NAME}),
          cpuUsed: Game.cpu.getUsed(),
          sourceMapSources: require('main.js.map').sources
        })`,
        BOT_NAME
      );
      await world.tick(1);
      const probe = await probePromise;

      assertRuntimeClean(world.report);
      assert.equal(world.report.ticksRun, TICKS + 1);
      assert.ok(
        probe.runs >= TICKS,
        `production loop ran only ${probe.runs} times`
      );
      assert.ok(probe.lastTick <= probe.gameTime);
      assert.equal(probe.roomVisible, true);
      assert.equal(typeof probe.cpuUsed, 'number');
      assert.ok(Number.isFinite(probe.cpuUsed));
      assert.ok(
        probe.sourceMapSources.some((source) =>
          source.endsWith('/src/index.ts')
        ),
        `source map does not contain src/index.ts: ${probe.sourceMapSources.join(', ')}`
      );

      const memory = await world.readMemory(BOT_NAME);
      assert.deepEqual(
        memory,
        {},
        'an app without persistent partitions must keep Memory empty'
      );

      console.log(
        `PASS: leviathan-runtime (${world.report.ticksRun} ticks, ${probe.runs} observed loops)`
      );
      return world.report;
    }
  );
}

module.exports = { run };
