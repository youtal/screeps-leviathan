/**
 * 文件摘要：在真实 Screeps 引擎中验证 MemoryManager 的持久化与恢复契约（设计 §10 最后一项）。
 *
 * 正式 app 产物没有申请分区的插件，因此本场景用构建入口额外生成的 `leviathan-core` 模块
 * （src/core/index.ts 的 CJS 产物）装配一个探针 bot：一个插件申请 state（小分区，每 tick 递增）
 * 与 bulk（大分区，按命令写入）。控制台命令只写入探针的 heap 变量，由下一 tick 的 loop 消费；
 * 场景从不直接改写 Memory/RawMemory。
 *
 * 覆盖：
 * 1. 跨 tick 长期访问器与 schemaVersion 2 写出；
 * 2. UTF-16 容量口径——接近上限的多字节文本被引擎接受，超限整串被管理器拒绝且存储不变，缩减后恢复；
 * 3. 完整提交 CPU——clean tick、仅小分区变化（大分区复用片段）、大分区重新编码三种情形的 loop CPU；
 * 4. CPU 硬终止——回调内死循环被引擎终止后，记录 heap 是否保留，并验证后续 tick 的 Framework
 *    与 MemoryManager 不被遗留锁卡死、终止前已接受的修改随后提交；
 * 5. global reset——以 Memory 快照启动新世界，访问器恢复历史数据而不重新初始化。
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
const { rawMemoryLimit } = require('../support/contract.json');

/** 探针 bot 的 main 模块：模块级代码每个 global 只执行一次，globals 计数据此判断 heap 是否重建。 */
const PROBE_MAIN = `
'use strict';
const core = require('leviathan-core');
const probe = (globalThis.__probe = globalThis.__probe || { globals: 0, runs: 0 });
probe.globals++;
const runtime = core.createRuntime({
  profiler: false,
  errorMapper: { loadSourceMap: () => { throw new Error('probe has no source map'); } },
});
let state;
let bulk;
const initState = () => ({ ticks: 0 });
const initBulk = () => ({ blob: '' });
probe.initializeCalls = 0;
const countedInitState = () => { probe.initializeCalls++; return initState(); };
const plugin = {
  manifest: { id: 'probe', version: 1 },
  setup(context) {
    state = context.memory('state', { version: 1, initialize: countedInitState });
    bulk = context.memory('bulk', { version: 1, initialize: initBulk });
  },
  onTickExecute() {
    const command = probe.command;
    probe.command = undefined;
    if (command && command.pause !== undefined) probe.paused = command.pause;
    if (!probe.paused) state.commit('ticks', state.get('ticks') + 1);
    if (command && command.blob !== undefined) bulk.commit('blob', command.blob);
    if (command && command.hang)
      state.commit((data) => {
        data.hungAt = Game.time;
        for (;;) {}
      });
  },
};
const framework = core.createFramework({ runtime, plugins: [plugin] });
probe.status = () => JSON.stringify({
  globals: probe.globals,
  runs: probe.runs,
  cpu: probe.lastLoopCpu,
  initializeCalls: probe.initializeCalls,
  ticks: state ? state.get('ticks') : null,
  framework: framework.getStatus(),
  dirty: runtime.memory.getStatus().dirty,
});
module.exports.loop = function () {
  probe.runs++;
  const start = Game.cpu.getUsed();
  framework.loop();
  probe.lastLoopCpu = Game.cpu.getUsed() - start;
};
`;

const probeModules = () => ({
  main: PROBE_MAIN,
  'leviathan-core': fs.readFileSync(path.join(SUPPORT, 'leviathan-core.js'), 'utf8'),
});

const worldOptions = (memory) => ({
  rooms: [
    {
      name: ROOM_NAME,
      controller: spec.controller({ level: 1 }),
      sources: [spec.source(10, 10)],
      structures: [spec.spawn(25, 25, { name: 'Spawn1' })],
    },
  ],
  bots: [{ username: BOT_NAME, rooms: ROOM_NAME, modules: probeModules() }],
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

async function readPartitions(world) {
  const memory = await world.readMemory(BOT_NAME);
  return memory.memoryManager;
}

/** 阶段 1–3：跨 tick 写出、UTF-16 容量、完整提交 CPU。 */
async function phasePersistenceAndCapacity() {
  return withWorld(worldOptions(), async (world) => {
    await world.tick(3);
    const first = await status(world);
    assert.equal(first.framework.safeMode, false);
    assert.equal(first.initializeCalls, 1);
    let namespace = await readPartitions(world);
    assert.equal(namespace.schemaVersion, 2);
    assert.equal(namespace.partitions.probe.state.payload.ticks, first.ticks);
    assert.ok(first.ticks >= 4, `访问器应跨 tick 持续递增，实际 ${first.ticks}`);
    console.log(`  阶段 1 通过：${first.ticks} tick 递增均已写出 schemaVersion 2`);

    // UTF-16 口径：多字节字符按码元计数；接近上限的文本（UTF-8 约 6 MB）必须被引擎接受。
    const accepted = rawMemoryLimit - 4096;
    await send(world, `{ blob: '中'.repeat(${accepted}) }`);
    const afterLarge = await status(world);
    assert.equal(afterLarge.framework.memory.rawWriteError, null);
    namespace = await readPartitions(world);
    assert.equal(namespace.partitions.probe.bulk.payload.blob.length, accepted);

    // 完整提交 CPU：大分区片段复用时仅小分区变化，与大分区重新编码、clean tick 对比。
    const smallOnly = (await status(world)).cpu;
    await send(world, `{ blob: '文'.repeat(${accepted}) }`);
    const bulkEncode = (await status(world)).cpu;
    await send(world, '{ pause: true }');
    await status(world);
    const clean = (await status(world)).cpu;
    await send(world, '{ pause: false }');
    console.log(
      `  阶段 3 记录：loop CPU clean=${clean.toFixed(3)} 仅小分区=${smallOnly.toFixed(3)} 大分区重编码=${bulkEncode.toFixed(3)}（主文本约 ${rawMemoryLimit - 4096} 码元）`
    );
    assert.ok(clean < bulkEncode, 'clean tick 必须显著低于大分区重编码');

    // 超限：整串拒绝，存储保持上一次成功的文本；缩减后恢复。
    const before = (await readPartitions(world)).partitions.probe.bulk.payload.blob;
    await send(world, `{ blob: '中'.repeat(${rawMemoryLimit + 10}) }`);
    const over = await status(world);
    assert.match(over.framework.memory.rawWriteError, /^capacity: .*exceeds/);
    assert.equal(over.framework.safeMode, false);
    assert.equal((await readPartitions(world)).partitions.probe.bulk.payload.blob, before);
    // 缩减为数字而非字符串：screeps-integration-tests 会把内联 Memory 快照中的任何嵌套字符串
    // 当作 fixture 名解析，阶段 5 用本阶段快照启动新世界，因此快照中不能留下字符串值。
    await send(world, '{ blob: 0 }');
    const recovered = await status(world);
    assert.equal(recovered.framework.memory.rawWriteError, null);
    namespace = await readPartitions(world);
    assert.equal(namespace.partitions.probe.bulk.payload.blob, 0);
    assert.equal(namespace.partitions.probe.state.payload.ticks, recovered.ticks);
    console.log(
      `  阶段 2 通过：${accepted} 个多字节码元被接受，超限整串拒绝且存储不变，缩减后恢复`
    );
    assertRuntimeClean(world.report);
    return world.readMemory(BOT_NAME);
  });
}

/** 阶段 4：回调内死循环触发 CPU 硬终止。 */
async function phaseHardTermination() {
  return withWorld(worldOptions(), async (world) => {
    await world.tick(2);
    const before = await status(world);
    await send(world, '{ hang: true }');
    await world.tick(1); // 本 tick 的 loop 在回调中被引擎终止
    await world.tick(1);
    const after = await status(world);
    const heapRetained = after.globals === before.globals && after.runs > before.runs;
    assert.equal(after.framework.safeMode, false, 'Framework 不得被遗留锁卡死');
    assert.deepEqual(after.framework.failures, []);
    assert.deepEqual(after.dirty, []);
    assert.ok(after.ticks > before.ticks, '后续 tick 必须继续递增');
    const namespace = await readPartitions(world);
    assert.equal(namespace.partitions.probe.state.payload.ticks, after.ticks);
    const logs = (world.report.logs || []).join('\n');
    const killed = /CPU limit reached|timed out|terminated/i.test(logs);
    if (heapRetained)
      assert.ok(
        Number.isInteger(namespace.partitions.probe.state.payload.hungAt),
        '终止前回调已接受的修改在 heap 保留时应随后提交'
      );
    console.log(
      `  阶段 4 通过：硬终止${killed ? '' : '（未见引擎终止日志）'}后 heap ${
        heapRetained ? '保留' : '重建'
      }（globals ${before.globals}→${after.globals}，runs ${before.runs}→${after.runs}），Framework 与 Memory 继续正常提交`
    );
  });
}

/** 阶段 5：以快照启动新世界，等价于 global reset。 */
async function phaseGlobalReset(snapshot) {
  const previous = snapshot.memoryManager.partitions.probe.state.payload.ticks;
  return withWorld(worldOptions(snapshot), async (world) => {
    const restored = await status(world);
    assert.equal(restored.globals, 1);
    assert.equal(restored.initializeCalls, 0, '历史分区不得重新初始化');
    assert.equal(restored.ticks, previous + 1);
    assertRuntimeClean(world.report);
    console.log(`  阶段 5 通过：新 global 从 ${previous} 恢复并继续递增`);
  });
}

async function run() {
  const snapshot = await phasePersistenceAndCapacity();
  await phaseHardTermination();
  await phaseGlobalReset(snapshot);
  console.log('PASS: leviathan-memory (5 阶段)');
}

module.exports = { run };
