/**
 * 文件摘要：场景 boot-judgment，真实引擎中 app.boot 的判定与不可逆操作（架构 11.4、11.8、11.9，docs/design/app/boot.md）。
 *
 * 世界一：开局世界 W（RCL1、一个 spawn、没有 creep，框架的 controller 没有 safe mode，时钟不可用），存储只有外来根键。
 * - 判为 FRESH_START（中，11.4 b′）：不清空，外来根键保留，本系统照常初始化；
 * - 经控制台 boot.force('FRESH_START') 人工确认后：普通模块已运行，先软重置；新实例备份原始 Memory、回读一致后清空，
 *   外来根键被移除、epoch 加 1，人工指定为一次性；
 * 世界二：房间里已有一个 creep（不是开局世界），存储为空——Memory 丢失而资产仍在，属于 M2 的接手分支。
 * - M1 判为 AMBIGUOUS（中）并初始化（设计第 4.3 节），使生存层可以运行；不清空。
 * 两个世界都没有错误输出。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, initialMemory, leviathanBot, withWorld } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'player';

/**
 * @description 运行场景。
 * @returns {Promise<void>} 两个世界都通过时 resolve。
 * @throws {assert.AssertionError} 任一断言失败。
 */
async function run() {
  const foreign = { legacy: { kept: true } };
  await withWorld({ rooms: [spec.baseRoom(ROOM)], bots: [leviathanBot(BOT, ROOM)], ...initialMemory(BOT, foreign), ticks: 40 }, async (world) => {
    await world.tick(3);
    let saved = await world.readMemory(BOT);
    assert.deepEqual(saved.legacy, foreign.legacy, '11.4 b′ 不清空，外来根键应保留');
    const first = saved.leviathan?.sys;
    assert.ok(first, `11.4 b′ 应初始化本系统命名空间，实际为 ${JSON.stringify(saved)}`);
    assert.deepEqual([first.mode.mode, first.mode.strength], ['FRESH_START', 'medium'], `应判为 FRESH_START（中），证据：${first.mode.evidence}`);

    await world.exec("boot.force('FRESH_START')");
    await world.tick(15);
    saved = await world.readMemory(BOT);
    assert.equal(saved.legacy, undefined, '人工确认后应清空，外来根键被移除');
    const sys = saved.leviathan.sys;
    assert.equal(sys.epoch, first.epoch + 1, '清空后 epoch 应加 1');
    assert.equal(sys.mode.mode, 'FRESH_START', `清空后模式应为 FRESH_START，证据：${sys.mode.evidence}`);
    assert.ok(sys.mode.evidence.includes('已备份并清空'), `应先备份再清空，证据：${sys.mode.evidence}`);
    assert.equal(saved.leviathan.part.boot?.control?.data?.force ?? null, null, 'FRESH_START 的人工指定应为一次性');
    assertRuntimeClean(world.report);
  });

  const room = spec.baseRoom(ROOM, { creeps: [spec.creep(25, 26, { name: 'survivor' })] });
  await withWorld({ rooms: [room], bots: [leviathanBot(BOT, ROOM)], ticks: 10 }, async (world) => {
    await world.tick(5);
    const saved = await world.readMemory(BOT);
    const sys = saved.leviathan?.sys;
    assert.ok(sys, `有资产而 Memory 为空时应初始化，实际为 ${JSON.stringify(saved)}`);
    assert.deepEqual([sys.mode.mode, sys.mode.strength], ['AMBIGUOUS', 'medium'], `应判为 AMBIGUOUS（中），证据：${sys.mode.evidence}`);
    assert.ok(sys.mode.evidence.some((e) => e.includes('M2')), `证据应说明接手判定在 M2 交付：${sys.mode.evidence}`);
    assert.equal(sys.epoch, 1, '不应清空');
    assertRuntimeClean(world.report);
  });
  console.log('PASS: boot-judgment');
}

module.exports = { run };
