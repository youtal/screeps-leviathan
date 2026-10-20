/**
 * 文件摘要：场景 kernel-smoke，真实引擎中正常循环的冒烟测试。
 *
 * 世界：一个 RCL1 房间（两个 source、一个 spawn），一个运行本项目产物的 bot。
 * 验证：
 * - 空存储：loop 逐 tick 被调用且正常返回；临时 boot 不初始化 Memory，存储保持为空；没有错误输出；
 * - 已初始化存储（含其他根键）：kernel 加载、提交后已有内容不变，其他根键原样保留；唯一新增的是 kernel 在普通模块
 *   首次 setup 前申请的启停标志分区 part.kernel.switches（docs/design/app/ops.md 第 3.2 节）；没有错误输出。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, initialMemory, leviathanBot, loopRuns, projectNamespace, withKernelPartition, withWorld } = require('../support/harness.cjs');

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
    assert.deepEqual(await world.readMemory(BOT), {}, '临时 boot 不初始化，空存储应保持为空');
    assertRuntimeClean(world.report);
  });

  const memory = { leviathan: projectNamespace(), legacy: { kept: true } };
  await withWorld({ rooms: [spec.baseRoom(ROOM)], bots: [leviathanBot(BOT, ROOM)], ...initialMemory(BOT, memory), ticks: TICKS }, async (world) => {
    await world.tick(TICKS - 1);
    assert.equal(await loopRuns(world), world.report.ticksRun, 'loop 应逐 tick 被调用且正常返回');
    assert.deepEqual(await world.readMemory(BOT), withKernelPartition(memory), '已初始化存储与其他根键应保持不变，只新增启停标志分区');
    assertRuntimeClean(world.report);
  });
  console.log('PASS: kernel-smoke');
}

module.exports = { run };
