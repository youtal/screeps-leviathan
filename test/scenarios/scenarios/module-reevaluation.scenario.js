/**
 * 文件摘要：场景 module-reevaluation，同一 global 中 main 模块被重新执行时的入口与 kernel 状态（内核设计第 6 节"模块重新执行"）。
 *
 * 平台事实：引擎每 tick 检查 `require.cache.main`，它不是对象、`loop` 不是函数或代码时间戳变化时，新建 `require`
 * 与空的模块缓存，但沿用同一个 `globals` 对象，在它上面重新执行 main（@screeps/engine 4.3.2 src/game/game.js 的
 * runCode 准备阶段）。官服在 2026-10-21 的线上运行中对本项目每 tick 都发生这一情况：全局上的控制台命名空间来自
 * 上一轮执行，入口与 kernel 每 tick 新建，跨 tick 的备份永远完成不了。
 * 本场景每 tick 经控制台执行 `delete require.cache.main`，在私服引擎中复现同样的条件。
 *
 * 世界：开局世界 W（框架的 controller 没有 safe mode，时钟不可用），存储只有外来根键。
 * 验证：
 * - 判为 FRESH_START（中，11.4 b′）并初始化；
 * - 人工确认 boot.force('FRESH_START') 之后，模块每 tick 重新执行的情况下，软重置、备份、回读与清空仍然完成；
 * - 控制台命名空间不被判为外来对象（没有"已被占用"错误），入口记录了模块的重新执行；
 * - 没有其他错误输出。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, initialMemory, leviathanBot, withWorld } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'player';

/**
 * @description 推进若干 tick，每个 tick 都让引擎在下一 tick 于同一 global 中重新执行 main。
 * 控制台表达式在本 tick 的 loop 之后执行，删除缓存后，引擎在下一 tick 准备阶段新建 require 并重新执行 main。
 * @param {object} world 世界实例。
 * @param {number} n tick 数。
 * @returns {Promise<void>} 推进完成后 resolve。
 */
const tickWithReevaluation = async (world, n) => {
  for (let i = 0; i < n; i += 1) {
    await world.exec('delete require.cache.main');
    await world.tick(1);
  }
};

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

    await tickWithReevaluation(world, 3);
    await world.exec("boot.force('FRESH_START')");
    await tickWithReevaluation(world, 20);

    const saved = await world.readMemory(BOT);
    const logs = world.report.logs.map(String);
    const count = (text) => logs.filter((line) => line.includes(text)).length;
    const summary = `"已被占用" ${count('已被占用')} 条，"启动判定" ${count('启动判定')} 条，"重新执行" ${count('main 模块在同一 global 中重新执行')} 条`;
    assert.equal(saved.legacy, undefined, `模块每 tick 重新执行时，人工确认后的清空仍应完成（${summary}），实际为 ${JSON.stringify(saved)}`);
    const sys = saved.leviathan.sys;
    assert.equal(sys.epoch, first.epoch + 1, '清空后 epoch 应加 1');
    assert.ok(sys.mode.evidence.includes('已备份并清空'), `应先备份再清空，证据：${sys.mode.evidence}`);

    assert.ok(count('main 模块在同一 global 中重新执行') > 0, `入口应记录模块的重新执行（${summary}）`);
    assertRuntimeClean(world.report);
  });
  console.log('PASS: module-reevaluation');
}

module.exports = { run };
