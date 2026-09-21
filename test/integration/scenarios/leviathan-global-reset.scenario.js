/**
 * 文件摘要：验证 Memory 跨 global 生命周期的可观测契约。
 *
 * 引擎与 mockup 均未提供"保留 storage、只重启玩家 isolate"的 API，因此本场景用
 * 「世界 A 运行 → 读取 Memory 快照 → 世界 B 以该快照启动」等价表达一次 global reset：
 * heap 全新（探针计数器从零开始），Memory 原样继承。场景同时覆盖两条持久化契约：
 *
 * 1. 外部兼容：旧 `leviathan` 根字段与无关根字段在运行后必须原样保留，旧插件数据
 *    一次性导入为 schemaVersion 2 分区，MemoryManager 只拥有 `memoryManager` 键（设计 §8）；
 * 2. 失败保护：命名空间 schemaVersion 不认识时锁定装载故障、进入安全模式、报告诊断且不覆盖
 *    任何存储（`namespace.ts` 的 loadStore 拒绝语义）。
 *
 * 分区写盘、容量、硬终止与访问器恢复需要申请分区的插件，见 leviathan-memory 场景。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const {
  assertRuntimeClean,
  formatFailureContext,
  loadProductionModules,
  withWorld,
} = require('../support/harness.js');

const ROOM_NAME = 'W0N1';
const BOT_NAME = 'leviathan';
const TICKS_A = 3;
const TICKS_B = 2;
const TICKS_C = 3;

/** 旧版 `Memory.leviathan` 布局的最小样本：插件数据 + 框架记录的插件版本。 */
const LEGACY_NAMESPACE = {
  plugins: { legacyProbe: { value: 42, nested: { flag: true } } },
  framework: { pluginVersions: { legacyProbe: 3 } },
};

/** 与 MemoryManager 无关的根字段，用于验证"保留无关根字段"。 */
const EXTERNAL_ROOT_FIELD = { keep: true, nested: { untouched: [1, 2, 3] } };

/** 未知的命名空间版本：实现只认识 schemaVersion 1（转换）与 2，其余必须拒绝覆盖。 */
const UNKNOWN_SCHEMA_VERSION = 99;

const baseOptions = (memory) => ({
  rooms: [
    {
      name: ROOM_NAME,
      controller: spec.controller({ level: 1 }),
      sources: [spec.source(10, 10), spec.source(40, 40)],
      structures: [spec.spawn(25, 25, { name: 'Spawn1' })],
    },
  ],
  bots: [
    {
      username: BOT_NAME,
      rooms: ROOM_NAME,
      modules: loadProductionModules(),
    },
  ],
  memory: { [BOT_NAME]: memory },
  logLevel: 'all',
});

/**
 * 读取 heap 探针计数，用于区分"新 global"与"旧 global 延续"。
 *
 * 玩家 console 命令在下一 tick 的 loop 之后执行，因此这里推进一 tick 后读到的就是
 * 新 isolate 的首个 loop 计数：新 global 必为 1，而继承旧 heap 时会得到
 * `TICKS_A + 1`。
 */
async function readProbeOnFirstTick(world) {
  const probePromise = world.evalInBot(
    `JSON.stringify({
      runs: globalThis.__leviathanIntegrationRuns,
      lastTick: globalThis.__leviathanIntegrationLastTick,
      gameTime: Game.time
    })`,
    BOT_NAME
  );
  await world.tick(1);
  return probePromise;
}

/**
 * 阶段 1：冷启动装载旧布局与无关根字段，运行后二者都必须原样保留。
 */
async function phaseExternalCompatibility() {
  return withWorld(
    baseOptions({
      leviathan: LEGACY_NAMESPACE,
      externalTool: EXTERNAL_ROOT_FIELD,
    }),
    async (world) => {
      await world.tick(TICKS_A);
      assertRuntimeClean(world.report);

      const memory = await world.readMemory(BOT_NAME);
      assert.deepEqual(
        memory.leviathan,
        LEGACY_NAMESPACE,
        '旧 leviathan 根字段必须只读保留，供回退使用'
      );
      assert.deepEqual(
        memory.externalTool,
        EXTERNAL_ROOT_FIELD,
        'MemoryManager 不得改写与自身无关的根字段'
      );
      assert.deepEqual(
        memory.memoryManager,
        {
          schemaVersion: 2,
          partitions: {
            legacyProbe: {
              main: { dataVersion: 3, payload: LEGACY_NAMESPACE.plugins.legacyProbe },
            },
          },
        },
        '旧插件数据应一次性导入为 schemaVersion 2 分区'
      );

      console.log(
        `  阶段 1 通过：旧布局与无关根字段在 ${world.report.ticksRun} tick 后原样保留`
      );
      return memory;
    }
  );
}

/**
 * 阶段 2：以阶段 1 的 Memory 快照启动新世界，等价于一次 global reset。
 *
 * heap 探针必须从零重新计数（证明 isolate/global heap 已重建），而 Memory 必须原样继承
 * 且不被二次初始化破坏。
 */
async function phaseCrossGlobalRestore(snapshot) {
  return withWorld(baseOptions(snapshot), async (world) => {
    const probe = await readProbeOnFirstTick(world);
    assert.equal(
      probe.runs,
      1,
      `新的 global 必须从零计数 heap 探针，期望 1；若 heap 被继承会得到 ${TICKS_A + 1}，实际 ${probe.runs}`
    );
    assert.ok(probe.lastTick <= probe.gameTime);

    // 覆盖恢复后的稳态：继续运行不产生新错误，Memory 也不被二次初始化改写。
    await world.tick(TICKS_B - 1);
    assertRuntimeClean(world.report);

    const memory = await world.readMemory(BOT_NAME);
    assert.deepEqual(
      memory.leviathan,
      LEGACY_NAMESPACE,
      'global 重建后旧布局必须仍然保留'
    );
    assert.deepEqual(
      memory.externalTool,
      EXTERNAL_ROOT_FIELD,
      'global 重建后无关根字段必须仍然保留'
    );

    console.log(
      `  阶段 2 通过：新 global heap 从零计数（${probe.runs} 次 loop），Memory 快照完整继承`
    );
    return memory;
  });
}

/**
 * 阶段 3：命名空间版本不可识别时，必须报告诊断并保持存储不变。
 */
async function phaseUnknownSchemaProtection() {
  const poisoned = { memoryManager: { schemaVersion: UNKNOWN_SCHEMA_VERSION } };
  return withWorld(baseOptions(poisoned), async (world) => {
    await world.tick(TICKS_C);

    const memory = await world.readMemory(BOT_NAME);
    assert.deepEqual(
      memory,
      poisoned,
      '无法识别的命名空间必须原样保留，绝不能被覆盖'
    );

    const logs = (world.report.logs || []).join('\n');
    assert.ok(
      logs.includes('storage load failed'),
      `缺少存储加载失败的诊断日志：${formatFailureContext(world.report)}`
    );
    assert.ok(
      logs.includes(
        `Unsupported MemoryManager schema: ${UNKNOWN_SCHEMA_VERSION}`
      ),
      '诊断日志必须给出无法识别的 schemaVersion'
    );
    // 装载故障是宿主故障：Framework 每 tick 进入安全模式并报告，但 tick 循环继续、不写回。
    assert.equal(world.report.ticksRun, TICKS_C);
    const probe = world.evalInBot('JSON.stringify(globalThis.__leviathanIntegrationRuns)', BOT_NAME);
    await world.tick(1);
    assert.equal(await probe, TICKS_C + 1, 'loop 不得因装载故障卡死');

    console.log(
      `  阶段 3 通过：未知 schemaVersion 被拒绝覆盖并留下诊断，${world.report.ticksRun} tick 未中断`
    );
    return world.report;
  });
}

async function run() {
  const snapshot = await phaseExternalCompatibility();
  await phaseCrossGlobalRestore(snapshot);
  const report = await phaseUnknownSchemaProtection();

  console.log('PASS: leviathan-global-reset (3 阶段)');
  return report;
}

module.exports = { run };
