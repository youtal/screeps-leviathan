/**
 * 文件摘要：场景 chaos，真实引擎中的扰动测试（架构 13.1 的 chaos、13.2 的混沌测试，M1 验收"混沌测试中保底循环能接管"）。
 *
 * 世界：一个 RCL1 房间（两个 source、一个 300 能量的 spawn，没有 creep），Memory 为空，正常循环先按 11.4 a 初始化。
 * 扰动全部从测试侧注入，不改产品代码：
 * - 强制 global reset：在 bot 中经控制台调用 Game.cpu.halt()。driver 销毁玩家的 isolate，本 tick 的运行结果整体作废，
 *   下一 tick 在新的 global 中运行（driver 5.3.0 的 lib/runtime/user-vm.js 与 lib/runtime/make.js）；
 * - 压低 CPU：修改私服用户表的 cpu 与 cpuAvailable，driver 每 tick 读取（本 tick 上限为两者之和，bucket 为 cpuAvailable）；
 * - 正常循环失效：把项目标记的 schema 改为高于代码的值，并在同一 tick halt，丢弃旧 global 的写回，新 global 加载失败。
 * M1 的模块清单为空，"跳过模块"的扰动在单元层混沌测试（test/chaos/chaos.test.ts）中以测试模块覆盖。
 * 验证：
 * - 每次 halt 后 loop 在新的 global 中运行，项目标记的 epoch 不变（没有误清空），lastRun 继续前进；
 * - 压低 CPU 期间 Game.cpu.limit 与 kernel 的预算 B 随之下降，正常循环每 tick 照常提交，健康状态为 ok；
 * - Memory 不可用后保底循环接管，孵化 fb- 前缀的应急采集者；
 * - 恢复 Memory 并 reset 后正常循环恢复：健康状态为 ok，连续 degraded 归零，lastRun 继续前进；
 * - 除预期的 Memory 错误与 halt 记录外没有其他错误输出。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, leviathanBot, loopRuns, withWorld } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'player';
/** 预期的错误：Memory 不可用期间 kernel 的记录，以及 driver 对 halt 的记录。 */
const EXPECTED = [/Memory 不可用/, /CPU halted/];

/**
 * @description 读取 ops.status() 的文本；控制台在下一 tick 的 loop 之后执行，所以推进 1 个 tick。
 * @param {object} world 世界实例。
 * @returns {Promise<string>} 状态文本。
 */
const status = async (world) => {
  const pending = world.evalInBot('ops.status()');
  await world.tick(1);
  return String(await pending);
};

/**
 * @description 让 bot 在下一 tick 调用 Game.cpu.halt()，并推进这个 tick；之后的 tick 在新的 global 中运行。
 * @param {object} world 世界实例。
 * @returns {Promise<void>} halt 的 tick 结束后 resolve。
 */
const halt = async (world) => {
  await world.exec('Game.cpu.halt()');
  await world.tick(1);
};

/**
 * @description 修改 bot 的 CPU 额度与 bucket（私服用户表），下一 tick 生效。
 * @param {object} world 世界实例。
 * @param {number} cpu 每 tick 额度。
 * @param {number} bucket bucket。
 * @returns {Promise<void>} 写入完成后 resolve。
 */
const setCpu = async (world, cpu, bucket) => {
  await world.server.common.storage.db.users.update({ _id: world.botId(BOT) }, { $set: { cpu, cpuAvailable: bucket } });
};

/**
 * @description 读取项目标记。
 * @param {object} world 世界实例。
 * @returns {Promise<object | undefined>} Memory.leviathan.sys。
 */
const marker = async (world) => (await world.readMemory(BOT))?.leviathan?.sys;

/**
 * @description 读取 fb- 前缀的 creep 名称。
 * @param {object} world 世界实例。
 * @returns {Promise<string[]>} 名称。
 */
const fallbackCreeps = async (world) => (await world.find({ type: 'creep' })).map((c) => c.name).filter((n) => n.startsWith('fb-'));

/**
 * @description 运行场景。
 * @returns {Promise<void>} 断言全部通过时 resolve。
 * @throws {assert.AssertionError} 任一断言失败。
 */
async function run() {
  await withWorld({ rooms: [spec.baseRoom(ROOM)], bots: [leviathanBot(BOT, ROOM)], ticks: 400 }, async (world) => {
    // 开局：空 Memory 判为 FRESH_START 并初始化。
    await world.tick(3);
    const start = await marker(world);
    assert.equal(start?.epoch, 1, '开局应初始化本项目命名空间');

    // 强制 reset：每次 halt 后在新的 global 中运行；epoch 不变，lastRun 前进。
    for (let i = 0; i < 3; i += 1) {
      await world.tick(5);
      const before = await loopRuns(world);
      const lastRun = (await marker(world)).lastRun;
      await halt(world);
      await world.tick(2);
      const after = await loopRuns(world);
      assert.ok(after < before, `halt 后应换成新的 global（loop 计数 ${before} → ${after}）`);
      const now = await marker(world);
      assert.equal(now.epoch, 1, 'reset 后不应清空 Memory');
      assert.ok(now.lastRun > lastRun, 'reset 后正常循环应继续提交');
    }

    // 压低 CPU：额度 20、bucket 0；预算随之下降，正常循环照常运行。
    const normal = await status(world);
    await setCpu(world, 20, 0);
    await world.tick(2);
    const limitPending = world.evalInBot('Game.cpu.limit');
    await world.tick(1);
    assert.equal(await limitPending, 20, '压低后的 CPU 额度应生效');
    // 逐 tick 读取 lastRun：每个 tick 都应恰好前进 1，只比较最终值不能排除中间的提交中断（审计 DV-09）。
    let lastRun = (await marker(world)).lastRun;
    for (let i = 0; i < 20; i += 1) {
      await world.tick(1);
      const next = (await marker(world)).lastRun;
      assert.equal(next, lastRun + 1, `压低 CPU 期间正常循环应每 tick 提交（第 ${i + 1} 个 tick：${lastRun} → ${next}）`);
      lastRun = next;
    }
    const squeezed = await status(world);
    assert.match(squeezed, /健康 ok/, `压低 CPU 期间健康状态应为 ok：\n${squeezed}`);
    const budget = (text) => Number(/B ([\d.]+)/.exec(text)?.[1]);
    assert.ok(budget(squeezed) < budget(normal), `压低 CPU 后预算应下降：${budget(normal)} → ${budget(squeezed)}`);
    await setCpu(world, 100, 10000);

    // 正常循环失效：schema 改为高于代码的值，同一 tick halt，丢弃旧 global 的写回；新 global 加载失败，保底接管。
    await world.writeMemory(BOT, { leviathan: { sys: { schema: 999 } } });
    await halt(world);
    let spawned = [];
    for (let i = 0; i < 40 && spawned.length === 0; i += 1) {
      await world.tick(1);
      spawned = await fallbackCreeps(world);
    }
    assert.ok(spawned.length > 0, 'Memory 不可用后保底循环应孵化应急采集者');
    const broken = await status(world);
    assert.match(broken, /连续 degraded [3-9]|连续 degraded \d{2,}/, `保底接管期间应连续 degraded：\n${broken}`);

    // 恢复：schema 改回，halt 后新 global 正常加载；正常循环恢复，degraded 归零。
    await world.writeMemory(BOT, { leviathan: { sys: { schema: 1 } } });
    await halt(world);
    await world.tick(5);
    const resumedFrom = (await marker(world)).lastRun;
    await world.tick(5);
    const resumed = await status(world);
    assert.match(resumed, /健康 ok/, `恢复后健康状态应为 ok：\n${resumed}`);
    assert.match(resumed, /连续 degraded 0/, `恢复后连续 degraded 应归零：\n${resumed}`);
    const final = await marker(world);
    assert.ok(final.lastRun > resumedFrom, '恢复后正常循环应继续提交');
    assert.equal(final.epoch, 1, '整个过程中不应清空 Memory');
    assertRuntimeClean(world.report, { allow: EXPECTED });
    console.log(`PASS: chaos（预算 B ${budget(normal)} → ${budget(squeezed)}；应急 creep：${spawned.join(', ')}）`);
  });
}

module.exports = { run };
