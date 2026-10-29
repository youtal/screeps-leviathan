/**
 * 文件摘要：场景 bench，在真实私服引擎中运行 bench 专用产物并输出原始计量结果，由 scripts/bench/cli.ts 构建与解析。
 *
 * 所属位置：test/bench/scenarios/，构建上下文中放在 scenarios/ 目录（scripts/bench/lib.ts 的 BENCH_INPUTS），
 * 共用 test/scenarios/support 的 harness。不属于 npm run test:scenarios 的场景集。
 * 世界：一个 RCL1 房间与一个运行 bench 产物的 bot；bench 不读写 Memory、不提交 intent。
 * 流程：逐 tick 推进，经控制台表达式读取 globalThis.__leviathanBench，直到全部用例完成或达到 tick 上限；
 * 随后以单行 `BENCH_RESULT <JSON>` 输出原始样本与运行环境（Node 与引擎版本），并断言运行期没有错误输出。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, leviathanBot, withWorld } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'bench';
/** tick 上限：当前用例约需 20 tick，留出余量给新增用例。 */
const MAX_TICKS = 400;

/**
 * @description 运行场景。
 * @returns {Promise<void>} 全部用例完成并输出结果后 resolve。
 * @throws {assert.AssertionError} 达到 tick 上限仍未完成，或运行期出现错误输出。
 */
async function run() {
  await withWorld({ rooms: [spec.baseRoom(ROOM)], bots: [leviathanBot(BOT, ROOM)], ticks: MAX_TICKS + 1 }, async (world) => {
    let state;
    for (let tick = 0; tick < MAX_TICKS; tick += 1) {
      // 控制台表达式在下一 tick 的 loop 之后执行，所以先提交再推进 1 tick。
      const pending = world.evalInBot('JSON.stringify(globalThis.__leviathanBench ?? null)');
      await world.tick(1);
      state = await pending;
      if (state?.done) break;
    }
    assert.ok(state?.done, `达到 ${MAX_TICKS} tick 仍未完成，当前状态：${JSON.stringify(state)?.slice(0, 200)}`);
    assertRuntimeClean(world.report);
    const env = { node: process.version, engine: require('@screeps/engine/package.json').version };
    console.log(`BENCH_RESULT ${JSON.stringify({ env, ticks: state.ticks, records: state.records })}`);
  });
  console.log('PASS: bench');
}

module.exports = { run };
