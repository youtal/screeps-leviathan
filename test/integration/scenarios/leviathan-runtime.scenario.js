/**
 * 文件摘要：在真实 Screeps 4.3 引擎中装载正式 Rollup 产物并验证连续 tick。
 *
 * 场景从 dist/main.js 与 sourcemap 构造玩家模块，只在内存中的 main 模块末尾追加执行计数器；
 * 仓库产物本身不会被改写。计数器驻留玩家 isolate 的 global heap，用于证明生产 loop 确实被
 * 引擎连续调用，同时不向 Memory 写入测试字段，也不绕过项目的 MemoryManager 访问边界。
 * 场景结束必须 dispose；框架外层 worker 会在退出时回收 mockup 尚未释放的 storage 句柄。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorld, spec } = require('screeps-integration-tests');
const { assertNoErrors } = require('screeps-integration-tests/assertions');

const ROOM_NAME = 'W0N1';
const BOT_NAME = 'leviathan';

/**
 * 将正式 bundle 与 sourcemap 转成 Screeps users.code 的模块表。
 *
 * screeps-integration-tests 默认只扫描 dist/*.js，无法把 JSON sourcemap 作为
 * `main.js.map` 模块上传；这里显式生成该模块，使 ErrorMapper 的游戏内 require 路径与部署
 * 环境一致。追加 wrapper 只记录调用次数和最近 tick，原 loop 的返回值与异常语义保持不变。
 */
const loadInstrumentedModules = () => {
  const distDir = process.env.BOT_DIST_DIR || path.resolve('dist');
  const mainPath = path.join(distDir, 'main.js');
  const sourceMapPath = path.join(distDir, 'main.js.map');
  const main = fs.readFileSync(mainPath, 'utf8');
  const sourceMap = fs.readFileSync(sourceMapPath, 'utf8');

  const probeWrapper = `
const __leviathanProductionLoop = module.exports.loop;
module.exports.loop = function leviathanIntegrationProbe() {
  const result = __leviathanProductionLoop();
  globalThis.__leviathanIntegrationRuns =
    (globalThis.__leviathanIntegrationRuns || 0) + 1;
  globalThis.__leviathanIntegrationLastTick = Game.time;
  return result;
};`;

  return {
    main: `${main}\n${probeWrapper}`,
    'main.js.map': `module.exports = ${sourceMap};`,
  };
};

/**
 * 构建一间最小可见房：bot 拥有 RCL1 控制器与 Spawn，真实 Game、CPU 计量和 Room 查询
 * 因而可用。查询探针通过玩家 console 在下一 tick 执行，返回 isolate 内部状态。
 */
async function run() {
  const world = await createWorld({
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
        modules: loadInstrumentedModules(),
      },
    ],
  });

  try {
    await world.tick(2);

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

    assertNoErrors(world.report);
    assert.equal(world.report.ticksRun, 3);
    assert.ok(probe.runs >= 2, `production loop ran only ${probe.runs} times`);
    assert.ok(probe.lastTick <= probe.gameTime);
    assert.equal(probe.roomVisible, true);
    assert.equal(typeof probe.cpuUsed, 'number');
    assert.ok(Number.isFinite(probe.cpuUsed));
    assert.ok(
      probe.sourceMapSources.some((source) => source.endsWith('/src/index.ts')),
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
  } finally {
    await world.dispose();
  }
}

module.exports = { run };
