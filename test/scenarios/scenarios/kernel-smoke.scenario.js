/**
 * 文件摘要：场景 kernel-smoke，真实引擎中正常循环的冒烟测试。
 *
 * 世界：一个 RCL1 房间（两个 source、一个 spawn、没有 creep），即放置 spawn 后的开局世界 W（架构 11.4）。
 * 框架构造的 controller 没有 safe mode，开局时钟不可用。一个运行本项目产物的 bot。
 * 验证：
 * - 空存储：loop 逐 tick 被调用且正常返回；app.boot 判为 FRESH_START（11.4 a）并初始化，项目标记的指纹记下本房间与
 *   spawn（M1 验收标准"放置 spawn 后正确判定开局"）；没有错误输出；
 * - 已初始化存储（含其他根键，指纹含本房间）：时钟不可用且房间在指纹中，证据不足以判为重生，判为 AMBIGUOUS、不清空；
 *   除项目标记外，已有内容与其他根键不变，只新增 kernel 的启停标志分区与 boot 的人工指定分区；没有错误输出。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, initialMemory, leviathanBot, loopRuns, projectNamespace, withRuntimePartitions, withWorld, withoutSys } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'player';
const TICKS = 20;

/**
 * @description 运行场景。
 * @returns {Promise<void>} 两个世界都通过时 resolve。
 * @throws {assert.AssertionError} 任一断言失败。
 */
async function run() {
  await withWorld({ rooms: [spec.baseRoom(ROOM)], bots: [leviathanBot(BOT, ROOM)], ticks: TICKS }, async (world) => {
    await world.tick(TICKS - 1);
    assert.equal(await loopRuns(world), world.report.ticksRun, 'loop 应逐 tick 被调用且正常返回');
    const saved = await world.readMemory(BOT);
    const sys = saved.leviathan?.sys;
    assert.ok(sys, `开局时 Memory 应被初始化，实际为 ${JSON.stringify(saved)}`);
    assert.deepEqual([sys.mode.mode, sys.mode.strength], ['FRESH_START', 'strong'], `应判为 FRESH_START（强），证据：${sys.mode.evidence}`);
    assert.equal(sys.epoch, 1, '初始化的 epoch 应为 1');
    assert.deepEqual(sys.fp.rooms, [ROOM], '指纹应记下本房间');
    assert.equal(sys.fp.spawnIds.length, 1, '指纹应记下 spawn');
    assertRuntimeClean(world.report);
  });

  const memory = { leviathan: projectNamespace({ fp: { rooms: [ROOM], spawnIds: [], creepCount: 0 } }), legacy: { kept: true } };
  await withWorld({ rooms: [spec.baseRoom(ROOM)], bots: [leviathanBot(BOT, ROOM)], ...initialMemory(BOT, memory), ticks: TICKS }, async (world) => {
    await world.tick(TICKS - 1);
    assert.equal(await loopRuns(world), world.report.ticksRun, 'loop 应逐 tick 被调用且正常返回');
    const saved = await world.readMemory(BOT);
    assert.deepEqual(withoutSys(saved), withRuntimePartitions(memory), '除项目标记外，已有内容与其他根键应保持不变，只新增运行期分区');
    assert.equal(saved.leviathan.sys.mode.mode, 'AMBIGUOUS', `证据不足时应判为 AMBIGUOUS，证据：${saved.leviathan.sys.mode.evidence}`);
    assert.equal(saved.leviathan.sys.epoch, 1, '不应清空');
    assertRuntimeClean(world.report);
  });
  console.log('PASS: kernel-smoke');
}

module.exports = { run };
