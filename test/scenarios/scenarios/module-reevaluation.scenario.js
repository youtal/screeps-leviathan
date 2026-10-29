/**
 * 文件摘要：场景 module-reevaluation，代码更新而 global 未重置时，main 在同一 global 中重新执行后的入口与 kernel 状态
 * （内核设计第 6 节"模块重新执行"）。
 *
 * 平台事实：引擎每 tick 检查 `require.cache.main`，它不是对象、`loop` 不是函数或代码时间戳变化时，新建 `require`
 * 与空的模块缓存，但沿用同一个 `globals` 对象，在它上面重新执行 main（@screeps/engine 4.3.2 src/game/game.js 的
 * runCode 准备阶段）。代码更新时触发的是时间戳条件；本场景经控制台执行一次 `delete require.cache.main`，在私服引擎中
 * 复现同样的重新执行。
 *
 * 世界：开局世界 W（框架的 controller 没有 safe mode，时钟不可用），存储只有外来根键。
 * 验证：
 * - 判为 FRESH_START（中，11.4 b′）并初始化；
 * - 重新执行后 `require.cache.main.loop` 是新的入口函数；控制台命名空间不被判为外来对象（没有"已被占用"错误）；
 * - 之后人工确认 boot.force('FRESH_START')，命令到达新 kernel，软重置、备份、回读与清空完成；
 * - 没有其他错误输出。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, initialMemory, leviathanBot, withWorld } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'player';
/** 控制台输出的标记前缀，用于从日志中取出探测结果。 */
const PROBE = 'reload-probe';

/**
 * @description 运行场景。
 * @returns {Promise<void>} 断言全部通过时 resolve。
 * @throws {assert.AssertionError} 任一断言失败。
 */
async function run() {
  const foreign = { legacy: { kept: true } };
  await withWorld({ rooms: [spec.baseRoom(ROOM)], bots: [leviathanBot(BOT, ROOM)], ...initialMemory(BOT, foreign), ticks: 60 }, async (world) => {
    await world.tick(3);
    const first = (await world.readMemory(BOT)).leviathan?.sys;
    assert.deepEqual([first?.mode.mode, first?.mode.strength], ['FRESH_START', 'medium'], '应先判为 FRESH_START（中）并初始化');

    // 控制台表达式在本 tick 的 loop 之后执行：记下当前入口并删除缓存，引擎在下一 tick 准备阶段新建 require 并重新执行 main。
    await world.exec('globalThis.__reloadProbe = require.cache.main.loop; delete require.cache.main');
    await world.tick(2);
    await world.exec(`console.log('${PROBE} ' + (typeof require.cache.main.loop === 'function' && require.cache.main.loop !== globalThis.__reloadProbe))`);
    await world.tick(1);

    await world.exec("boot.force('FRESH_START')");
    await world.tick(20);

    const saved = await world.readMemory(BOT);
    const logs = world.report.logs.map(String);
    const count = (text) => logs.filter((line) => line.includes(text)).length;
    assert.equal(count(`${PROBE} true`), 1, `重新执行后应换成新的入口函数（探测输出：${logs.filter((l) => l.includes(PROBE)).join('；')}）`);
    assert.equal(count('已被占用'), 0, '上一轮安装的控制台命名空间不应被判为外来对象');
    assert.equal(saved.legacy, undefined, `重新执行后，人工确认的清空应完成，实际为 ${JSON.stringify(saved)}`);
    const sys = saved.leviathan.sys;
    assert.equal(sys.epoch, first.epoch + 1, '清空后 epoch 应加 1');
    assert.ok(sys.mode.evidence.includes('已备份并清空'), `应先备份再清空，证据：${sys.mode.evidence}`);
    assertRuntimeClean(world.report);
  });
  console.log('PASS: module-reevaluation');
}

module.exports = { run };
