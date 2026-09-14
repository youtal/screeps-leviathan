/**
 * 文件摘要：集成场景共享的产物装载、运行期断言与失败诊断工具。
 *
 * 场景统一通过本模块装载正式 Rollup 产物、判定"运行期是否出错"以及在断言失败时附带
 * 引擎侧证据，避免每个场景各自复制一份探针与错误口径。
 *
 * 主要能力：
 * - `loadProductionModules()`：把 `dist/main.js` 与 `dist/main.js.map` 转成玩家模块表，
 *   并在内存中的 main 模块末尾追加 heap 探针；不改写仓库产物；
 * - `assertRuntimeClean()`：合并框架的 console 分类断言与日志中的抛出型错误扫描；
 * - `withWorld()`：创建世界、执行场景体、失败时把引擎报告附到异常消息、始终 dispose。
 *
 * 状态与副作用：不读写 Memory 命名空间，不修改 `dist/`，不访问 `.secret.json`；
 * 每个场景进程内只创建私服实例，dispose 由 `withWorld` 保证。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorld } = require('screeps-integration-tests');
const { assertNoErrors } = require('screeps-integration-tests/assertions');

/**
 * 玩家 main 模块末尾追加的探针。
 *
 * 计数器驻留玩家 isolate 的 global heap：它能证明生产 loop 被引擎连续调用，又不会写入
 * Memory（本项目要求 Memory 只由 MemoryManager 掌控）。异常语义保持不变——探针只在调用
 * 成功返回后计数，不捕获也不吞掉原 loop 抛出的错误。
 */
const PROBE_WRAPPER = `
const __leviathanProductionLoop = module.exports.loop;
module.exports.loop = function leviathanIntegrationProbe() {
  const result = __leviathanProductionLoop();
  globalThis.__leviathanIntegrationRuns =
    (globalThis.__leviathanIntegrationRuns || 0) + 1;
  globalThis.__leviathanIntegrationLastTick = Game.time;
  return result;
};`;

/**
 * 抛出型错误的日志行判定。
 *
 * 框架自带的 `report.errors` 只按硬编码模式分类（`TypeError:`、`is not defined` 等），
 * 普通 `throw new Error('...')` 不会进入其中，只留在 `report.logs`——而这是最常见的
 * 业务异常形态。这里补上该缺口：匹配 V8 输出异常首行的形式，逐行扫描以兼容把整个堆栈
 * 合成一条日志的引擎行为。
 */
// 前缀可选：既要匹配 `TypeError:`，也要匹配最常见的裸 `Error:`；\b 保证 \n// `ErrorRate: 1` 这类以 Error 开头的普通词不会被误判。
const THROWN_ERROR_LINE = /^(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*)?Error\b/;

/**
 * 读取正式产物并追加探针，返回 `addBot` 需要的模块表。
 *
 * 框架默认只扫描 `dist/*.js`，无法把 JSON sourcemap 作为 `main.js.map` 模块上传；
 * 这里显式生成该模块，使 ErrorMapper 的游戏内 `require('main.js.map')` 路径与部署一致。
 *
 * @param {string} [distDir] 产物目录，默认取 `BOT_DIST_DIR` 或仓库 `dist/`
 * @returns {Object<string,string>} 模块名到源码的映射
 */
function loadProductionModules(
  distDir = process.env.BOT_DIST_DIR || path.resolve('dist')
) {
  const main = fs.readFileSync(path.join(distDir, 'main.js'), 'utf8');
  const sourceMap = fs.readFileSync(path.join(distDir, 'main.js.map'), 'utf8');
  return {
    main: `${main}\n${PROBE_WRAPPER}`,
    'main.js.map': `module.exports = ${sourceMap};`,
  };
}

/**
 * 从报告日志中筛出抛出型错误行。
 *
 * @param {Object} report 框架 WorldReport
 * @returns {string[]} 命中的错误首行（去重前按出现顺序）
 */
function collectThrownErrors(report) {
  const hits = [];
  for (const entry of report.logs || []) {
    for (const line of String(entry).split('\n')) {
      const trimmed = line.trim();
      if (THROWN_ERROR_LINE.test(trimmed)) {
        hits.push(trimmed);
        break;
      }
    }
  }
  return hits;
}

/**
 * 断言运行期无错误：框架分类 + 日志抛出型错误扫描。
 *
 * 场景需要显式使用 `logLevel: 'all'`，否则 `report.logs` 可能被过滤，日志扫描只能算
 * 尽力而为；框架分类断言不受该设置影响。
 *
 * @param {Object} report 框架 WorldReport
 */
function assertRuntimeClean(report) {
  assertNoErrors(report);
  const thrown = collectThrownErrors(report);
  assert.equal(
    thrown.length,
    0,
    `bot console reported ${thrown.length} thrown error(s):\n${thrown.join('\n')}`
  );
}

/**
 * 汇总失败现场：错误、告警与日志尾部。
 *
 * 集成失败的常见表现是 `evalInBot` 超时——此时真正的异常堆栈留在 `report.logs` 里，
 * 不打印就只能看到框架的通用提示。本函数把这些证据拼成可读文本供断言失败时附上。
 *
 * @param {Object} report 框架 WorldReport
 * @param {number} [tail] 附加的日志条数
 * @returns {string}
 */
function formatFailureContext(report, tail = 6) {
  if (!report) return '（无世界报告：世界可能尚未创建成功）';
  const lines = [
    `运行现场：ticksRun=${report.ticksRun} wallClockMs=${report.wallClockMs} stopReason=${report.stopReason}`,
    `errors=${JSON.stringify(report.errors)}`,
    `warnings=${JSON.stringify(report.warnings)}`,
  ];
  // 抛出型错误放在日志之前：CLI 汇总会截断长消息，关键行必须最靠前。
  const thrown = collectThrownErrors(report);
  if (thrown.length > 0) {
    lines.push(`抛出型错误 ${thrown.length} 条（框架分类未覆盖）：`);
    for (const line of thrown.slice(0, 3)) lines.push('  ' + line);
  }
  const logs = report.logs || [];
  const shown = logs.slice(-tail);
  lines.push(`logs(${logs.length}) 尾部 ${shown.length} 条：`);
  for (const entry of shown) {
    lines.push('  ' + String(entry).split('\n')[0].slice(0, 200));
  }
  return lines.join('\n');
}

/**
 * 创建世界、执行场景体、失败时附带现场、结束时必定 dispose。
 *
 * @param {Object} options `createWorld` 参数
 * @param {(world: Object) => Promise<any>} body 场景主体
 * @returns {Promise<any>} body 的返回值
 */
async function withWorld(options, body) {
  const world = await createWorld(options);
  try {
    return await body(world);
  } catch (error) {
    // 保留原始堆栈，只补充引擎侧证据；抛错类型与语义不变。
    // 抛出型错误前置：即使首个失败是 evalInBot 超时，真实异常也必须在消息开头可见。
    const thrown = collectThrownErrors(world.report);
    const headline =
      thrown.length > 0
        ? `bot console reported ${thrown.length} thrown error(s); first: ${thrown[0]}\n`
        : '';
    error.message = `${headline}${error.message}\n\n${formatFailureContext(world.report)}`;
    throw error;
  } finally {
    await world.dispose();
  }
}

module.exports = {
  assertRuntimeClean,
  collectThrownErrors,
  formatFailureContext,
  loadProductionModules,
  withWorld,
};
