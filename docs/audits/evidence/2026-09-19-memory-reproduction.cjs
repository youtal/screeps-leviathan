/**
 * 2026-09-19 审计复现：仅在普通对象模拟的 Raw/Segment 平台中执行 MemoryManager。
 * 从仓库根运行 node docs/audits/evidence/2026-09-19-memory-reproduction.cjs。
 * 使用项目已安装的 TypeScript 编译内存模块；不修改源码、真实游戏存储或网络服务。
 * 输出是基线版本缺陷的观测值，不是期望长期保留的正确行为；修复后应改写为正式回归断言。
 * 三个用例依次覆盖：外来目标页清理、配置外目标页清理、恢复期间写入丢失。
 */
const fs = require('fs'),
  path = require('path'),
  Module = require('module');
const root = path.resolve(__dirname, '../../..');
const ts = require(root + '/node_modules/typescript');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  return resolve.call(
    this,
    name.startsWith('@/') ? root + '/src/' + name.slice(2) : name,
    ...args
  );
};
Module._extensions['.ts'] = (mod, file) =>
  mod._compile(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    file
  );
const { createMemoryManager } = require(
  root + '/src/core/memoryManager/createMemoryManager.ts'
);
const logging = {
  scope: () =>
    Object.fromEntries(
      ['debug', 'info', 'warn', 'error', 'report', 'success'].map((k) => [
        k,
        () => {},
      ])
    ),
};
const make = (phase, segmentId = 0) => ({
  memoryManager: {
    schemaVersion: 1,
    generationCounter: 1,
    allocations: { worker: { main: { backend: 'raw', generation: 0 } } },
    rawPartitions: { worker: { main: { dataVersion: 1, payload: { n: 1 } } } },
    migration: {
      generation: 1,
      phase,
      reason: 'allocation',
      moves: [
        {
          pluginId: 'worker',
          localId: 'main',
          dataVersion: 1,
          from: 'raw',
          to: 'segment',
          toSegmentId: segmentId,
        },
      ],
      staged: phase === 'copy' ? {} : { 'worker/main': { n: 1 } },
    },
  },
});
function harness(rawObj, pages) {
  let raw = JSON.stringify(rawObj);
  const writes = [];
  return {
    pages,
    writes,
    raw: () => raw,
    platform: {
      readRaw: () => raw,
      writeRaw: (s) => (raw = s),
      readSegments: () => pages,
      writeSegment: (id, s) => {
        writes.push(id);
        pages[id] = s;
      },
      activeSegments: () => Object.keys(pages).map(Number),
      activateSegments: () => {},
    },
  };
}
for (const target of [0, 99]) {
  const h = harness(make('copy', target), { [target]: 'foreign-data' });
  const m = createMemoryManager({
    logging,
    platform: h.platform,
    segmentIds: [0],
  });
  m.begin(1);
  m.end(1);
  console.log(
    JSON.stringify({
      case: 'abort-foreign-page',
      target,
      remaining: h.pages[target],
      writtenPages: h.writes,
    })
  );
}
const envelope = {
  schemaVersion: 1,
  owner: { pluginId: 'worker', localId: 'main' },
  generation: 1,
  dataVersion: 1,
  payload: { n: 1 },
};
const h = harness(make('verify'), { 0: JSON.stringify(envelope) });
const m = createMemoryManager({
  logging,
  platform: h.platform,
  segmentIds: [0],
});
m.begin(1);
const a = m.bind('worker')('main', {
  version: 1,
  layer: 'critical',
  priority: 1,
  initialize: () => ({ n: 0 }),
});
const access = a.access();
console.log(
  JSON.stringify({ case: 'recovered-migration-access', status: access.status })
);
if (access.status === 'ready') access.commit((data) => (data.n = 2));
m.end(1);
for (let t = 2; t <= 3; t++) {
  m.begin(t);
  m.end(t);
}
const restored = createMemoryManager({
  logging,
  platform: h.platform,
  segmentIds: [0],
});
restored.begin(4);
const view = restored
  .bind('worker')('main', {
    version: 1,
    layer: 'critical',
    priority: 1,
    initialize: () => ({ n: 0 }),
  })
  .access();
console.log(
  JSON.stringify({
    case: 'recovered-migration-write',
    committed: 2,
    restored: view.status === 'ready' ? view.query() : view,
  })
);
