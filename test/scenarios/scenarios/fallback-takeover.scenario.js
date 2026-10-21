/**
 * 文件摘要：场景 fallback-takeover，Memory 不可用时由保底循环接管房间（架构 5.7，保底循环设计 docs/design/fallback.md）。
 *
 * 世界：一个 RCL1 房间（两个 source、一个 300 能量的 spawn，没有 creep），存储预置 schema 不符的本项目命名空间。
 * 机制：kernel.memory 拒绝加载，kernel 每 tick 报告 degraded；连续 3 个 degraded tick 后入口追加保底循环。
 * 验证：
 * - Memory 不可用只记录一次，存储内容不被改写；
 * - 保底循环孵化 fb- 前缀的应急采集者；
 * - 采集者在 source 旁采集到接近装满（不少于 40 点）才离开，而不是每采一次就往返（保底工人采集规则）；
 * - 除上述预期的 Memory 错误外没有其他错误输出。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, initialMemory, leviathanBot, projectNamespace, withWorld } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'player';
const TICKS = 200;
/** 预期的错误：kernel 记录 Memory 不可用，正文附带加载失败的堆栈。 */
const EXPECTED = [/Memory 不可用/];

/**
 * @description 运行场景。
 * @returns {Promise<void>} 断言全部通过时 resolve。
 * @throws {assert.AssertionError} 任一断言失败。
 */
async function run() {
  const memory = { leviathan: projectNamespace({ schema: 999 }) };
  const names = new Set();
  let maxCarried = 0;
  await withWorld({
    rooms: [spec.baseRoom(ROOM)],
    bots: [leviathanBot(BOT, ROOM)],
    ...initialMemory(BOT, memory),
    ticks: TICKS,
    /**
     * @description 每 tick 记录出现过的 creep 名称与携带能量的最大值。
     * @param {object} world 世界实例。
     * @returns {Promise<void>} 记录完成时 resolve。
     */
    onTick: async (world) => {
      for (const creep of await world.find({ type: 'creep' })) {
        names.add(creep.name);
        maxCarried = Math.max(maxCarried, creep.store?.energy ?? 0);
      }
    },
  }, async (world) => {
    await world.run();
    assert.equal(world.report.logs.filter((line) => /Memory 不可用/.test(line)).length, 1, 'Memory 不可用应只记录一次');
    assert.deepEqual(await world.readMemory(BOT), memory, '加载失败时不应改写存储');
    assert.ok([...names].some((name) => name.startsWith('fb-')), `保底循环应孵化应急采集者，出现过的 creep：${[...names].join(', ')}`);
    assert.ok(maxCarried >= 40, `采集者应装满后再离开 source，携带能量最大值为 ${maxCarried}`);
    assertRuntimeClean(world.report, { allow: EXPECTED });
  });
  console.log(`PASS: fallback-takeover（creep：${[...names].join(', ')}；最大携带 ${maxCarried}）`);
}

module.exports = { run };
