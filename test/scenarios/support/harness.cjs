/**
 * 文件摘要：私服场景共用的产物装载、世界生命周期与运行期断言，只在测试镜像中运行。
 *
 * 所属位置：test/scenarios/support/，由 test/scenarios/scenarios/*.scenario.js 使用；框架为 screeps-integration-tests。
 * 主要能力：
 * - leviathanBot：用宿主端生成的模块表（main 与 main.js.map，见 scripts/scenarios/cli.ts）组成 bot 规格，
 *   并在 main 末尾追加调用计数探针（只写 global heap，不写 Memory）；
 * - withWorld：创建世界、执行场景体，失败时附上最近的控制台输出，始终 dispose；
 * - assertRuntimeClean：框架的错误分类之外，再扫描抛错首行与 logger 的 ERROR 级别行；
 * - loopRuns：读取探针计数，证明 loop 被引擎逐 tick 调用；
 * - botModules：未加探针的模块表，供场景核对 bot 实际运行的产物与 source map。
 * 状态：模块表在首次装载后缓存于本模块；不读写宿主文件、不访问网络与凭据。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorld } = require('screeps-integration-tests');
const { assertNoErrors } = require('screeps-integration-tests/assertions');

/** 宿主端生成的模块表：{ [模块名]: 源码 }。 */
const MODULES_FILE = path.join(__dirname, '..', 'bot', 'modules.json');

/** 追加在 main 末尾的探针：只在原 loop 正常返回后计数，异常原样传播。 */
const PROBE = `
const __leviathanLoop = module.exports.loop;
module.exports.loop = function leviathanScenarioProbe() {
  const result = __leviathanLoop();
  globalThis.__leviathanRuns = (globalThis.__leviathanRuns || 0) + 1;
  return result;
};`;

/** 抛错首行：V8 的 `Error:`、`TypeError:` 等，可带 Uncaught 前缀；逐行匹配，兼容整段堆栈合成一条日志。 */
const THROWN_LINE = /^(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*)?Error\b/;
/** logger 的 error 级别行：纯文本为 `[<tick>] ERROR <作用域>:`，上色时前缀包在 span 中。 */
const LOGGER_ERROR = /\[\d+\] ERROR(?:<\/span>)? /;

let cached;

/**
 * @description 读取宿主端生成的模块表，不加探针；探针只追加在 main 末尾，不改变已有代码的行列。
 * @returns {Record<string, string>} 模块表的副本：{ [模块名]: 源码 }，source map 模块为 main.js.map。
 */
const botModules = () => {
  cached ??= JSON.parse(fs.readFileSync(MODULES_FILE, 'utf8'));
  return { ...cached };
};

/**
 * @description 读取模块表并在 main 末尾追加调用计数探针。
 * @returns {Record<string, string>} 模块表的副本。
 */
const loadModules = () => {
  const modules = botModules();
  return { ...modules, main: `${modules.main}\n${PROBE}` };
};

/**
 * @description 组成运行本项目产物的 bot 规格。
 * @param {string} username bot 名称。
 * @param {string | string[]} rooms bot 拥有的房间。
 * @returns {import('screeps-integration-tests').BotSpec} bot 规格。
 */
const leviathanBot = (username, rooms) => ({ username, rooms, modules: loadModules() });

/**
 * @description 断言运行期干净：框架归类的错误为空，日志中没有抛错首行或 logger 的 ERROR 级别行。
 * @param {object} report world.report。
 * @param {object} [options] 可选项。
 * @param {RegExp[]} [options.allow] 允许出现的错误行（例如场景有意制造的故障）。
 * @returns {void}
 * @throws {assert.AssertionError} 存在未被允许的错误行。
 */
const assertRuntimeClean = (report, options = {}) => {
  const allow = options.allow ?? [];
  /**
   * @description 判断一行错误输出是否在允许列表中。
   * @param {string} line 错误行。
   * @returns {boolean} 匹配任一允许的模式时为 true。
   */
  const allowed = (line) => allow.some((pattern) => pattern.test(line));
  assertNoErrors({ ...report, errors: report.errors.filter((line) => !allowed(line)) });
  const bad = report.logs.filter((entry) => {
    const text = String(entry);
    if (allowed(text)) return false;
    return LOGGER_ERROR.test(text) || text.split('\n').some((line) => THROWN_LINE.test(line.trim()));
  });
  assert.deepEqual(bad, [], `运行期出现错误：\n${bad.join('\n')}`);
};

/**
 * @description 读取探针计数：本 global 中 loop 正常返回的次数。控制台表达式在下一 tick 的 loop 之后执行，
 * 所以本函数会推进 1 个 tick，返回的计数包含这个 tick。
 * @param {object} world 世界实例。
 * @returns {Promise<number>} 调用次数；探针未运行时为 0。
 */
const loopRuns = async (world) => {
  const pending = world.evalInBot('globalThis.__leviathanRuns || 0');
  await world.tick(1);
  return Number(await pending);
};

/**
 * @description 创建世界并执行场景体；失败时把最近的控制台输出附到异常消息，始终 dispose。
 * @param {object} options createWorld 的选项；logLevel 默认 all，以便断言能看到全部日志。
 * @param {(world: object) => Promise<void>} body 场景体。
 * @returns {Promise<object>} world.report。
 * @throws {Error} 场景体或断言失败，消息附带最近 40 行控制台输出。
 */
const withWorld = async (options, body) => {
  const world = await createWorld({ logLevel: 'all', ...options });
  try {
    await body(world);
    return world.report;
  } catch (error) {
    const tail = world.report.logs.slice(-40).join('\n');
    if (error instanceof Error) error.message = `${error.message}\n--- 最近的控制台输出 ---\n${tail}`;
    throw error;
  } finally {
    await world.dispose();
  }
};

/**
 * @description 构造已初始化的本项目命名空间（与 app.assembly 的 MEMORY_IDENTITY 一致：命名空间与签名为 leviathan，schema 为 1）。
 * @param {object} [marker] 覆盖项目标记的字段，例如 { schema: 999 } 构造身份不符的命名空间。
 * @returns {object} 可作为 Memory.leviathan 的命名空间对象。
 */
const projectNamespace = (marker = {}) => ({
  sys: {
    sig: 'leviathan', schema: 1, shard: 'x', epoch: 1, lastRun: 1, release: 'scenario',
    fp: { rooms: [], spawnIds: [], creepCount: 0 },
    mode: { mode: 'AMBIGUOUS', strength: 'medium', since: 1, evidence: [] },
    ...marker,
  },
  part: {}, rooms: {}, creeps: {}, flags: {},
});

/**
 * @description 已初始化存储经正常循环运行后的预期内容（不含项目标记）：kernel 在普通模块首次 setup 前申请启停标志分区
 * part.kernel.switches（docs/design/app/ops.md 第 3.2 节），app.boot 在 Memory 就绪后申请人工指定分区 part.boot.control
 * （docs/design/app/boot.md 第 8 节）；项目标记由 boot 按 6.7 更新，用 withoutSys 去掉后再比较。
 * @param {object} memory 初始 Memory，其中 leviathan 为 projectNamespace() 的结果。
 * @returns {object} 预期的 Memory，去掉了 leviathan.sys。
 */
const withRuntimePartitions = (memory) => withoutSys({ ...memory, leviathan: { ...memory.leviathan,
  part: { ...memory.leviathan.part, kernel: { switches: { version: 1, data: {} } },
    boot: { control: { version: 1, data: { force: null } } } } } });

/**
 * @description 去掉本项目命名空间中的项目标记，供不关心 sys 的整体比较使用。
 * @param {object} memory Memory。
 * @returns {object} 浅拷贝，leviathan.sys 被移除；没有命名空间时原样返回。
 */
const withoutSys = (memory) => {
  if (!memory?.leviathan) return memory;
  const { sys: _sys, ...rest } = memory.leviathan;
  return { ...memory, leviathan: rest };
};

/**
 * @description 生成设置初始 Memory 的 createWorld 选项。框架创建世界前会递归扫描 memory 选项，把其中任何字符串值
 * 都当成 fixture 名去查找文件（screeps-integration-tests 3.0.0），而本项目的标记含字符串字段；memoryOverrides
 * 不参与该扫描，在没有 memory 时它本身就是初始 Memory，所以统一经它传入。
 * @param {string} bot bot 名称。
 * @param {object} memory 初始 Memory。
 * @returns {{ memoryOverrides: object }} 可展开进 createWorld 选项的对象。
 */
const initialMemory = (bot, memory) => ({ memoryOverrides: { [bot]: memory } });

module.exports = { assertRuntimeClean, botModules, initialMemory, leviathanBot, loopRuns, projectNamespace, withRuntimePartitions, withWorld, withoutSys };
