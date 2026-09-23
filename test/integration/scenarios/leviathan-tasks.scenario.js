/**
 * 文件摘要：在真实 Screeps 引擎中验证 TaskScheduler 的跨 tick 驱动与硬终止恢复
 * （TaskScheduler 设计 §5.7 要求的私服实测）。
 *
 * 与 leviathan-memory 相同，本场景用构建入口额外生成的 `leviathan-core` 模块（src/core/index.ts
 * 的 CJS 产物）装配探针 bot：一个插件每 tick 无条件提交计数任务（每片忙等约 0.5 CPU、每 tick
 * 上限 1 CPU，需要多个 tick 才能完成）；收到控制台命令时写入分区标记，并提交一个分片内死循环
 * 的任务。控制台命令只写入探针的 heap 变量，由下一 tick 的 loop 消费；场景从不直接改写
 * Memory/RawMemory。
 *
 * 覆盖：
 * 1. 生成器状态跨 tick 保留：计数任务跨多个 tick 推进并完成；完成后每 tick 的 submit 返回同一
 *    实例，不重新计算；
 * 2. 分片内硬终止：drive 中的死循环被引擎终止后，下一 tick 按 body 重启一次，再次被终止后以
 *    failed 结束；heap 保留，Framework 不进入 safeMode，插件继续运行；
 * 3. drive 位于 MemoryHost.end 之后：硬终止所在 tick 已提交的分区标记必须落盘，heap 与存储一致；
 * 4. 跨 global 重启记录：以 Memory 快照启动新世界（等价于一次 global reset），调度器分区中存续
 *    实例的 reset 次数加一。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, withWorld } = require('../support/harness.js');

const ROOM_NAME = 'W0N1';
const BOT_NAME = 'leviathan';
const SUPPORT = path.join(__dirname, '../support');

/**
 * 探针 bot 的 main 模块：模块级代码每个 global 只执行一次，globals 计数据此判断 heap 是否重建。
 * submitLong 为真时插件每 tick 还提交一个不会结束的任务，供阶段 4 观察跨 global 记录。
 */
const probeMain = ({ submitLong = false } = {}) => `
'use strict';
const SUBMIT_LONG = ${submitLong};
const core = require('leviathan-core');
const probe = (globalThis.__probe = globalThis.__probe || { globals: 0, runs: 0 });
probe.globals++;
probe.slices = 0;
probe.countCalls = 0;
probe.hangCalls = 0;
const runtime = core.createRuntime({
  profiler: false,
  errorMapper: { loadSourceMap: () => { throw new Error('probe has no source map'); } },
});
const spin = (cpu) => {
  const start = Game.cpu.getUsed();
  while (Game.cpu.getUsed() - start < cpu) {}
};
const countBody = () => {
  probe.countCalls++;
  return (function* () {
    for (let i = 0; i < 10; i++) {
      spin(0.5);
      probe.slices++;
      yield;
    }
    return 'counted';
  })();
};
const longBody = () =>
  (function* () {
    for (;;) {
      spin(0.5);
      yield;
    }
  })();
const hangBody = () => {
  probe.hangCalls++;
  return (function* () {
    for (;;) {}
  })();
};
let state;
const plugin = {
  manifest: { id: 'probe', version: 1 },
  setup(context) {
    state = context.memory('state', { version: 1, initialize: () => ({ marker: 0 }) });
  },
  onTickExecute(context) {
    const command = probe.command;
    probe.command = undefined;
    context.tasks.submit('count', countBody, { minBucket: 0, maxCpuPerTick: 1 });
    if (SUBMIT_LONG) context.tasks.submit('long', longBody, { minBucket: 0, maxCpuPerTick: 1 });
    if (command && command.hang) {
      state.commit('marker', Game.time);
      context.tasks.submit('hang', hangBody, { minBucket: 0 });
    }
  },
};
// 探针不依赖私服的 bucket 数值：Framework 与任务的 bucket 门限都设为 0。
const framework = core.createFramework({ runtime, plugins: [plugin], minBucket: 0 });
const tasks = runtime.tasks.bind('probe');
const view = (handle) =>
  handle ? { state: handle.state, message: handle.failure ? handle.failure.message : null } : null;
probe.status = () => JSON.stringify({
  globals: probe.globals,
  runs: probe.runs,
  slices: probe.slices,
  countCalls: probe.countCalls,
  hangCalls: probe.hangCalls,
  count: view(tasks.get('count')),
  hang: view(tasks.get('hang')),
  long: view(tasks.get('long')),
  marker: state ? state.get('marker') : null,
  framework: framework.getStatus(),
  dirty: runtime.memory.getStatus().dirty,
  cpu: { limit: Game.cpu.limit, tickLimit: Game.cpu.tickLimit, bucket: Game.cpu.bucket },
});
module.exports.loop = function () {
  probe.runs++;
  framework.loop();
};
`;

const worldOptions = (probe = {}, memory) => ({
  rooms: [
    {
      name: ROOM_NAME,
      controller: spec.controller({ level: 1 }),
      sources: [spec.source(10, 10)],
      structures: [spec.spawn(25, 25, { name: 'Spawn1' })],
    },
  ],
  bots: [
    {
      username: BOT_NAME,
      rooms: ROOM_NAME,
      modules: {
        main: probeMain(probe),
        'leviathan-core': fs.readFileSync(path.join(SUPPORT, 'leviathan-core.js'), 'utf8'),
      },
    },
  ],
  ...(memory ? { memory: { [BOT_NAME]: memory } } : {}),
  logLevel: 'all',
});

/** 提交控制台代码并推进一 tick；控制台在该 tick 的 loop 之后执行，结果反映 loop 之后的状态。 */
async function consoleTick(world, code) {
  const pending = world.evalInBot(code, BOT_NAME);
  await world.tick(1);
  return pending;
}

const status = (world) => consoleTick(world, '__probe.status()');
const send = (world, command) =>
  consoleTick(world, `__probe.command = ${command}; 'queued'`);

/** 阶段 1：生成器跨 tick 推进并完成，完成后不重算。 */
async function phaseCrossTick() {
  return withWorld(worldOptions(), async (world) => {
    const progress = [];
    let current = await status(world);
    for (let i = 0; i < 20 && current.count && current.count.state !== 'done'; i++) {
      progress.push(current.slices);
      current = await status(world);
    }
    assert.equal(current.count.state, 'done', `计数任务应在 20 tick 内完成，进度 ${progress.join(',')}`);
    assert.equal(current.slices, 10);
    assert.ok(
      progress.some((slices) => slices > 0 && slices < 10),
      `计数任务应跨多个 tick 推进，进度 ${progress.join(',')}`
    );
    const doneRuns = current.runs;
    const after = await status(world);
    const later = await status(world);
    assert.ok(later.runs > doneRuns);
    assert.equal(later.count.state, 'done');
    assert.equal(later.slices, 10, '完成后每 tick 的 submit 不得重新计算');
    assert.equal(later.countCalls, 1);
    assert.equal(after.framework.safeMode, false);
    assertRuntimeClean(world.report);
    console.log(
      `  阶段 1 通过：计数任务跨 tick 推进（${progress.join('→')}→10）后完成，此后不再重算（CPU limit=${later.cpu.limit} tickLimit=${later.cpu.tickLimit} bucket=${later.cpu.bucket}）`
    );
  });
}

/** 阶段 2–3：分片内死循环触发 CPU 硬终止；终止所在 tick 已提交的 Memory 必须落盘。 */
async function phaseHardTermination() {
  return withWorld(worldOptions(), async (world) => {
    await world.tick(2);
    const before = await status(world);
    await send(world, '{ hang: true }');
    await world.tick(1); // 本 tick：写入标记并提交，drive 中的死循环被引擎终止
    await world.tick(1); // 下一 tick：按 body 重启一次，再次被终止
    const after = await status(world); // 再下一 tick：重启次数用尽，任务以 failed 结束
    const heapRetained = after.globals === before.globals && after.runs > before.runs;
    const logs = (world.report.logs || []).join('\n');
    const kills = (logs.match(/CPU limit reached|timed out|terminated/gi) || []).length;
    assert.ok(heapRetained, `硬终止后 heap 应保留（globals ${before.globals}→${after.globals}）`);
    assert.equal(after.hangCalls, 2, '被中断的任务应按 body 重启一次');
    assert.equal(after.hang.state, 'failed');
    assert.match(after.hang.message, /interrupted by the hard CPU limit 2 times/);
    assert.equal(after.framework.safeMode, false, 'Framework 不得进入 safeMode');
    assert.deepEqual(after.framework.failures, []);
    assert.deepEqual(after.dirty, []);
    assert.equal(after.count.state, 'done', '其他任务的实例不受影响');
    const memory = await world.readMemory(BOT_NAME);
    const stored = memory.memoryManager.partitions.probe.state.payload.marker;
    assert.ok(Number.isInteger(after.marker) && after.marker > 0);
    assert.equal(
      stored,
      after.marker,
      '硬终止所在 tick 已由 MemoryHost.end 提交的标记必须落盘'
    );
    console.log(
      `  阶段 2 通过：分片内死循环被终止 ${kills} 次（日志计数），重启 1 次后以 failed 结束；heap 保留（globals ${before.globals}→${after.globals}，runs ${before.runs}→${after.runs}），Framework 未进入 safeMode`
    );
    console.log(`  阶段 3 通过：终止所在 tick 提交的标记 ${stored} 已落盘，heap 与存储一致`);
  });
}

/** 阶段 4：以快照启动新世界（等价于 global reset），存续实例的 reset 次数加一。 */
async function phaseGlobalRestartRecord() {
  const recordOf = (memory) =>
    memory.memoryManager.partitions.framework.tasks.payload.probe.long;
  const snapshot = await withWorld(worldOptions({ submitLong: true }), async (world) => {
    await world.tick(3);
    const memory = await world.readMemory(BOT_NAME);
    assert.equal(recordOf(memory), 0, '存续实例应以 0 次 reset 登记');
    return memory;
  });
  return withWorld(worldOptions({ submitLong: true }, snapshot), async (world) => {
    const restored = await status(world);
    assert.equal(restored.globals, 1, '新世界必须是新的 global');
    assert.equal(restored.long.state, 'running');
    const memory = await world.readMemory(BOT_NAME);
    assert.equal(recordOf(memory), 1, '跨过一次 global reset 的实例应计为 1 次');
    assertRuntimeClean(world.report);
    console.log('  阶段 4 通过：快照启动的新 global 中，存续任务的 reset 记录由 0 变为 1，任务照常运行');
  });
}

async function run() {
  await phaseCrossTick();
  await phaseHardTermination();
  await phaseGlobalRestartRecord();
  console.log('PASS: leviathan-tasks (4 阶段)');
}

module.exports = { run };
