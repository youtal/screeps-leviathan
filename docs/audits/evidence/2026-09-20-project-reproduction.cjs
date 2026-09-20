/**
 * 项目审计复现工具：仅注入内存平台，不访问游戏、凭据或网络，不修改源码。
 * 从仓库根运行：node docs/audits/evidence/2026-09-20-project-reproduction.cjs
 * 断言用于固定审计基线的缺陷表现，不是修复后的合格行为断言；修复后应改变输出并补正式回归。
 * 状态：S01–S04 已在 fix/audit-2026-09-20 修复，本脚本在修复后的代码上会断言失败，仅作历史证据；
 * 正式回归见 test/memoryManager.test.ts 与 test/framework.test.ts，整改记录见 ../2026-09-20-remediation.md §10。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return resolve.call(this, request.startsWith('@/')
    ? path.join(root, 'src', request.slice(2)) : request, ...args);
};
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText, filename);
};
const { createMemoryManager } = require(path.join(root, 'src/core/memoryManager/createMemoryManager.ts'));
const { createFramework } = require(path.join(root, 'src/core/framework/createFramework.ts'));
const { createRuntime } = require(path.join(root, 'src/core/runtime/createRuntime.ts'));
const logger = Object.fromEntries(['debug', 'warn', 'error', 'success', 'info', 'report']
  .map((key) => [key, () => undefined]));
logger.isEnabled = () => false;
const logging = { scope: () => logger };

function harness(initial, pages = {}, extra = {}) {
  let raw = JSON.stringify(initial);
  let tick = 0;
  const platform = {
    readRaw: () => raw,
    writeRaw: (text) => { raw = text; },
    readSegments: () => pages,
    writeSegment: (id, text) => { pages[id] = text; },
    activeSegments: () => Object.keys(pages).map(Number),
    activateSegments: () => undefined,
  };
  const make = () => createMemoryManager({ logging, platform,
    segmentIds: Object.keys(pages).map(Number), ...extra });
  const manager = make();
  return { manager, make, pages, raw: () => raw,
    run(fn) { manager.begin(++tick); fn?.(); manager.end(tick); } };
}
const envelope = (payload, generation = 1) => JSON.stringify({
  schemaVersion: 1, owner: { pluginId: 'owner', localId: 'main' },
  generation, dataVersion: 1, payload,
});
const options = { version: 1, layer: 'critical', initialize: () => ({ n: 0 }) };
const results = {};

// S01a: 损坏 journal 缺 staged，完整源页仍在；恢复阶段不得将源页清空。
{
  const h = harness({ memoryManager: {
    schemaVersion: 1, generationCounter: 2,
    allocations: { owner: { main: { backend: 'segment', segmentId: 0, generation: 1 } } },
    rawPartitions: {},
    migration: { generation: 2, phase: 'switch', reason: 'preemption',
      moves: [{ pluginId: 'owner', localId: 'main', dataVersion: 1,
        from: 'segment', fromSegmentId: 0, fromGeneration: 1, to: 'raw' }], staged: {} },
  } }, { 0: envelope({ n: 42 }) });
  h.run();
  h.run();
  const record = JSON.parse(h.raw()).memoryManager.rawPartitions.owner.main;
  assert.equal(h.pages[0], '');
  assert.equal(Object.hasOwn(record, 'payload'), false);
  const restarted = h.make();
  restarted.begin(100);
  const access = restarted.bind('owner')('main', options).access();
  assert.equal(access.reason, 'recovery');
  results.S01_missing_staged = { sourcePageCleared: true, rawRecord: record,
    afterReset: access.status + ':' + access.reason };
}

// S01b: 使用正常流程生成 verify journal，仅破坏目标 payload，保留完整的头部身份。
{
  const h = harness({}, { 0: '' });
  let accessor;
  for (let i = 0; i < 8; i++) {
    h.run(() => { accessor ??= h.manager.bind('owner')('main', { ...options, priority: 1 }); });
    if (h.manager.getStatus().migration?.phase === 'verify') break;
  }
  assert.equal(h.manager.getStatus().migration.phase, 'verify');
  const corrupted = JSON.parse(h.pages[0]);
  corrupted.payload = null;
  h.pages[0] = JSON.stringify(corrupted);
  for (let i = 0; i < 3; i++) h.run();
  const ns = JSON.parse(h.raw()).memoryManager;
  assert.equal(ns.rawPartitions.owner?.main, undefined);
  const restarted = h.make();
  restarted.begin(100);
  const access = restarted.bind('owner')('main', options).access();
  assert.equal(access.reason, 'recovery');
  results.S01_corrupt_target = { validRawSourceDeleted: true,
    targetPayload: JSON.parse(h.pages[0]).payload, afterReset: access.status + ':' + access.reason };
}

// S02: critical 订阅者抛错，发布者自身返回成功；独立业务意图不应在故障后继续提交。
{
  const trace = [];
  const game = { time: 1, cpu: { getUsed: () => 0, limit: 20, tickLimit: 100, bucket: 10000 } };
  const memory = { begin() {}, end() {}, deferStartupWindow() {},
    getStatus: () => ({ rawWriteError: null }), bind: () => () => { throw new Error('unused'); } };
  const runtime = createRuntime({ platform: { getGame: () => game }, profiler: false,
    errorMapper: { report() {}, loadSourceMap() { throw new Error('no map'); } } }, { logging, memory });
  const framework = createFramework({ runtime, plugins: [
    { manifest: { id: 'critical', version: 1, critical: true }, setup(ctx) {
      ctx.bus.subscribe({ scope: 'global' }, 'creep:spawn', 'broken', () => {
        trace.push('critical listener failed'); throw new Error('critical event failure');
      });
    } },
    { manifest: { id: 'publisher', version: 1 }, onTickBegin(ctx) {
      ctx.bus.publish({ scope: 'global' }, 'creep:spawn', { creepName: 'probe' });
    } },
    { manifest: { id: 'worker', version: 1 }, onTickExecute(ctx) {
      ctx.intents.submit({ subjectId: 'probe', channel: 'move', execute() {
        trace.push('business action committed'); return 0;
      } });
    } },
  ] });
  framework.loop();
  assert.deepEqual(trace, ['critical listener failed', 'business action committed']);
  assert.equal(framework.getStatus().safeMode, true);
  results.S02 = { trace, finalSafeMode: true,
    failures: framework.getStatus().failures.map(({ pluginId, phase }) => ({ pluginId, phase })) };
}

// S03: undefined 是合法的 JS 根字段值，原生 JSON.stringify 会省略它；拼接器不得写非法 JSON。
{
  const h = harness({}, {}, { getHostMemory: () => ({ optional: undefined, rooms: {} }) });
  h.run(() => h.manager.bind('owner')('main', options));
  assert.match(h.raw(), /"optional":undefined/);
  assert.equal(h.manager.getStatus().rawWriteError, null);
  assert.throws(() => JSON.parse(h.raw()));
  const restarted = h.make();
  restarted.begin(100);
  assert.notEqual(restarted.getStatus().fault, null);
  results.S03 = { nativeJSON: JSON.stringify({ optional: undefined, rooms: {} }),
    emittedInvalidToken: '"optional":undefined', writeReportedSuccessful: true,
    resetHasGlobalFault: true };
}
// S04: 文档中 setup 内联 initialize 的接入方式，在同一 global 停用再启用时产生新函数引用。
{
  const h = harness({});
  const game = { time: 1, cpu: { getUsed: () => 0, limit: 20, tickLimit: 100, bucket: 10000 } };
  const runtime = createRuntime({ platform: { getGame: () => game }, profiler: false,
    errorMapper: { report() {}, loadSourceMap() { throw new Error('no map'); } } },
    { logging, memory: h.manager });
  let executions = 0;
  const framework = createFramework({ runtime, plugins: [{
    manifest: { id: 'consumer', version: 1 },
    setup(ctx) { ctx.memory('main', { version: 1, layer: 'critical', initialize: () => ({ n: 0 }) }); },
    onTickExecute() { executions++; },
  }] });
  framework.loop();
  framework.disable('consumer'); game.time++; framework.loop();
  framework.enable('consumer'); game.time++; framework.loop();
  const failures = framework.getStatus().failures;
  assert.equal(executions, 1);
  assert.match(failures[0].message, /conflicting declaration/);
  results.S04 = { executions, reenableFailure: failures[0].message,
    phase: failures[0].phase };
}
console.log(JSON.stringify({ node: process.version, results }, null, 2));
