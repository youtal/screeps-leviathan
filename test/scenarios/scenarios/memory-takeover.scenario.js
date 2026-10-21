/**
 * 文件摘要：场景 memory-takeover，真实引擎中 Memory 接管的隔离效果（架构 6.6，内核设计第 6 节）。
 *
 * 世界：一个 RCL1 房间，bot 运行本项目产物，存储预置本项目命名空间与一个其他根键。
 * 操作：经控制台命令让 spawn 孵化一个 creep。引擎的 spawnCreep 总会写 Memory.creeps[name]；
 * 入口每 tick 先把全局 Memory 换成临时对象，这次写入只应落在临时对象上。
 * 验证：creep 孵化成功；存储中没有 creeps 根键；除项目标记外，命名空间与其他根键不变（只新增 kernel 的启停标志分区与
 * boot 的人工指定分区）；没有错误输出。预置标记的指纹含本房间，开局时钟不可用，boot 判为 AMBIGUOUS、不清空。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, initialMemory, leviathanBot, projectNamespace, withRuntimePartitions, withWorld, withoutSys } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'player';
const CREEP = 'scenario-mover';

/**
 * @description 运行场景。
 * @returns {Promise<void>} 断言全部通过时 resolve。
 * @throws {assert.AssertionError} 任一断言失败。
 */
async function run() {
  const memory = { leviathan: projectNamespace({ fp: { rooms: [ROOM], spawnIds: [], creepCount: 0 } }), legacy: { kept: true } };
  await withWorld({ rooms: [spec.baseRoom(ROOM)], bots: [leviathanBot(BOT, ROOM)], ...initialMemory(BOT, memory), ticks: 30 }, async (world) => {
    await world.tick(2);
    await world.exec(`Object.values(Game.spawns)[0].spawnCreep([MOVE], '${CREEP}')`);
    await world.tick(10);
    assert.ok(await world.findOne({ type: 'creep', name: CREEP }), 'creep 应已孵化');
    const saved = await world.readMemory(BOT);
    assert.equal(saved.creeps, undefined, '引擎写入的 Memory.creeps 不应落盘');
    assert.deepEqual(withoutSys(saved), withRuntimePartitions(memory), '除项目标记外，命名空间与其他根键应保持不变，只新增运行期分区');
    assert.equal(saved.leviathan.sys.mode.mode, 'AMBIGUOUS', `应保持 AMBIGUOUS，证据：${saved.leviathan.sys.mode.evidence}`);
    assertRuntimeClean(world.report);
  });
  console.log('PASS: memory-takeover');
}

module.exports = { run };
