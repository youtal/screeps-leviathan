/**
 * 文件摘要：验证本环境提供的 RawMemory Segment 语义基线。
 *
 * MemoryManager 的 Segment 后端依赖三条基础语义：激活后跨 tick 可读写、内容按页隔离、
 * 单页容量足够承载 SEGMENT_CAPACITY。场景按"先激活、等一 tick、再写入"的顺序执行，
 * 因此在强制激活延迟与不强制两种引擎行为下都成立，可用于发现升级引擎后的行为漂移。
 *
 * 已实测的环境特性（与线上 Screeps 不同，见 docs/testing/integration.md 已知边界）：
 * - 未调用 setActiveSegments 也能直接读写 Segment；本环境不强制激活前置条件；
 * - `RawMemory.get().activeSegments` 恒为 null，不能作为激活断言；
 * - 单页写入约 12 万字符会让 isolate 崩溃而不是抛出可捕获错误，因此"超限拒绝写入"
 *   的失败路径无法在本环境验证，容量断言只覆盖 SEGMENT_CAPACITY 这一合法上界。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spec } = require('screeps-integration-tests');
const {
  assertRuntimeClean,
  loadProductionModules,
  withWorld,
} = require('../support/harness.js');

const ROOM_NAME = 'W0N1';
const BOT_NAME = 'leviathan';

/** 场景使用的页号；MemoryManager 规划 0..9，当前生产 bundle 尚未占用任何页。 */
const SEGMENT_A = 0;
const SEGMENT_B = 1;
const SEGMENT_CAPACITY_TEST = 2;

/**
 * 从源码读取 SEGMENT_CAPACITY，避免测试与实现各写一份常量后漂移。
 *
 * 场景运行在 Node 侧，可以直接读 TypeScript 源文件；这里只做一次正则提取，解析失败即
 * 让场景失败，避免静默跳过容量断言。
 */
function readSegmentCapacity() {
  const source = fs.readFileSync(
    path.resolve('src/core/memoryManager/types.ts'),
    'utf8'
  );
  const matched = /SEGMENT_CAPACITY\s*=\s*([\d_]+)/.exec(source);
  assert.ok(
    matched,
    '未能在 src/core/memoryManager/types.ts 中找到 SEGMENT_CAPACITY'
  );
  return Number(matched[1].replace(/_/g, ''));
}

async function run() {
  const capacity = readSegmentCapacity();

  return withWorld(
    {
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
          modules: loadProductionModules(),
        },
      ],
      logLevel: 'all',
    },
    async (world) => {
      // 阶段 1：激活后等待一 tick，写入两页不同内容。
      const activatePromise = world.evalInBot(
        `RawMemory.setActiveSegments([${SEGMENT_A}, ${SEGMENT_B}]); 'activated'`,
        BOT_NAME
      );
      await world.tick(1);
      await activatePromise;

      const writePromise = world.evalInBot(
        `(() => {
          RawMemory.segments[${SEGMENT_A}] = 'segment-a';
          RawMemory.segments[${SEGMENT_B}] = 'segment-b';
          return JSON.stringify({
            a: RawMemory.segments[${SEGMENT_A}],
            b: RawMemory.segments[${SEGMENT_B}]
          });
        })()`,
        BOT_NAME
      );
      await world.tick(1);
      const written = await writePromise;
      assert.equal(
        written.a,
        'segment-a',
        '激活后的同 tick 写入必须立即对读取可见'
      );
      assert.equal(written.b, 'segment-b');

      const readPromise = world.evalInBot(
        `JSON.stringify({
          a: RawMemory.segments[${SEGMENT_A}],
          b: RawMemory.segments[${SEGMENT_B}],
          c: RawMemory.segments[${SEGMENT_CAPACITY_TEST}] === undefined
            ? null
            : RawMemory.segments[${SEGMENT_CAPACITY_TEST}]
        })`,
        BOT_NAME
      );
      await world.tick(1);
      const readBack = await readPromise;

      // 阶段 2：跨 tick 持久与按页隔离。
      assert.equal(readBack.a, 'segment-a', 'Segment 内容必须跨 tick 持久');
      assert.equal(readBack.b, 'segment-b', '不同页必须互相隔离');
      assert.notEqual(readBack.a, readBack.b);

      // 阶段 3：合法容量上界可完整往返。
      const capacityWritePromise = world.evalInBot(
        `(() => {
          RawMemory.segments[${SEGMENT_CAPACITY_TEST}] = 'x'.repeat(${capacity});
          return String(RawMemory.segments[${SEGMENT_CAPACITY_TEST}].length);
        })()`,
        BOT_NAME
      );
      await world.tick(1);
      // evalInBot 会把返回值按其 JSON 形态解析，长度以数字形式返回。
      assert.equal(
        await capacityWritePromise,
        capacity,
        '写入后同 tick 长度不符'
      );

      const capacityReadPromise = world.evalInBot(
        `JSON.stringify({
          length: (RawMemory.segments[${SEGMENT_CAPACITY_TEST}] || '').length,
          intact: RawMemory.segments[${SEGMENT_CAPACITY_TEST}] === 'x'.repeat(${capacity})
        })`,
        BOT_NAME
      );
      await world.tick(1);
      const capacityRead = await capacityReadPromise;
      assert.equal(
        capacityRead.length,
        capacity,
        `单页必须能承载 SEGMENT_CAPACITY=${capacity} 个字符`
      );
      assert.equal(capacityRead.intact, true, '容量上界内容必须完整往返');

      assertRuntimeClean(world.report);

      console.log(
        `PASS: leviathan-segments (${world.report.ticksRun} ticks, 单页容量 ${capacity} 字符往返完整)`
      );
      return world.report;
    }
  );
}

module.exports = { run };
