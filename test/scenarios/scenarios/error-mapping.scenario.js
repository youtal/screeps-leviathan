/**
 * 文件摘要：场景 error-mapping，真实运行时中的堆栈格式与源码映射（errorMapper 设计 docs/design/kernel/errorMapper.md"验证"）。
 *
 * 世界：一个 RCL1 房间，存储预置 schema 不符的本项目命名空间。每个新 global 中 kernel.memory 加载失败，
 * kernel 记录一次"Memory 不可用"，正文为 errorMapper 格式化的加载错误堆栈。
 * 步骤：
 * 1. bucket 为 200（低于 ERROR_MAP_BUCKET）：errorMapper 不映射，日志给出原始堆栈并注明"未映射：CPU 保护"；
 * 2. bucket 改为 10000，经 Game.cpu.halt() 换成新的 global：同一错误再记录一次，这次经 require('main.js.map') 映射。
 * 验证：
 * - 真实帧的格式为 `at <函数名> (main:<行>:<列>)`，errorMapper 的帧匹配规则覆盖它；
 * - 逐帧比对：用本文件独立实现的 Source Map v3 解码（不使用 src 的实现）换算原始帧，结果与 errorMapper 的映射一致；
 *   没有映射数据的帧（追加在 main 末尾的场景探针、运行时自身的帧）在两次输出中保持原样；
 * - 原始帧在 bot 实际运行的产物文本中，首帧指向 `new Error(`，其余帧指向函数调用，说明运行时报告的行列没有偏移；
 * - 产物第 1 行没有可执行代码：driver 编译模块时在第 1 行前拼接 `(function __module(module,exports){ `
 *   （36 个字符，driver 5.3.0 的 lib/runtime/runtime-driver.js 的 evalCode），第 1 行的列号因此偏移，errorMapper 不校正。
 */
'use strict';

const assert = require('node:assert/strict');
const { spec } = require('screeps-integration-tests');
const { assertRuntimeClean, botModules, initialMemory, leviathanBot, projectNamespace, withWorld } = require('../support/harness.cjs');

const ROOM = 'W0N1';
const BOT = 'player';
/** 预期的错误：每个 global 的 Memory 不可用记录，以及 driver 对 halt 的记录。 */
const EXPECTED = [/Memory 不可用/, /CPU halted/];
/** errorMapper 每条堆栈映射的帧数上限（MAP_FRAME_LIMIT）。 */
const MAP_FRAME_LIMIT = 10;
/** 位于 main 模块的帧：前缀、可选的函数名、行与列，与 errorMapper 的 FRAME 规则相同。 */
const MAIN_FRAME = /^(\s*at\s+)(?:(.*?)\s+\()?main:(\d+):(\d+)\)?\s*$/;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * @description 解码一个 Base64 VLQ 段为整数字段。
 * @param {string} segment mappings 中逗号分隔的一段。
 * @returns {number[]} 字段（相对值）。
 */
const decodeSegment = (segment) => {
  const fields = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = BASE64.indexOf(ch);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return fields;
};

/**
 * @description 按 Source Map v3 求生成位置对应的源码位置：逐行累加到目标行，取生成列不大于目标列的最后一段。
 * @param {{ mappings: string, sources: string[] }} map source map。
 * @param {number} line 生成行，从 1 起。
 * @param {number} column 生成列，从 1 起（V8 堆栈的列）。
 * @returns {string | undefined} `src/<文件>:<行>:<列>`（均从 1 起）；没有映射时为 undefined。
 */
const originalPosition = (map, line, column) => {
  const lines = map.mappings.split(';');
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let found;
  for (let i = 0; i < line && i < lines.length; i += 1) {
    let generated = 0;
    for (const segment of lines[i].split(',')) {
      if (segment === '') continue;
      const f = decodeSegment(segment);
      generated += f[0];
      if (f.length >= 4) {
        source += f[1];
        sourceLine += f[2];
        sourceColumn += f[3];
      }
      if (i === line - 1 && generated <= column - 1) {
        found = f.length >= 4 ? `${map.sources[source].replace(/^(\.\.\/|\.\/)+/, '')}:${sourceLine + 1}:${sourceColumn + 1}` : undefined;
      }
    }
  }
  return found;
};

/**
 * @description 从日志行中取出堆栈：日志经 logger 转义，换行为 <br>，尖括号与 & 为实体。
 * @param {string} entry 日志行。
 * @returns {string[]} 堆栈的各行。
 */
const stackLines = (entry) => String(entry).split('<br>')
  .map((line) => line.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

/**
 * @description 运行场景。
 * @returns {Promise<void>} 断言全部通过时 resolve。
 * @throws {assert.AssertionError} 任一断言失败。
 */
async function run() {
  const modules = botModules();
  const main = modules.main.split('\n');
  const map = JSON.parse(modules['main.js.map'].replace(/^module\.exports = /, '').replace(/;\s*$/, ''));
  assert.match(main[0], /^\s*(['"]use strict['"];)?\s*$/, `产物第 1 行不应有可执行代码（driver 的模块包装使第 1 行列号偏移）：${main[0]}`);

  const memory = { leviathan: projectNamespace({ schema: 999 }) };
  await withWorld({
    rooms: [spec.baseRoom(ROOM)],
    bots: [{ ...leviathanBot(BOT, ROOM), cpu: 20, cpuAvailable: 200 }],
    ...initialMemory(BOT, memory),
    ticks: 20,
  }, async (world) => {
    await world.tick(3);
    await world.server.common.storage.db.users.update({ _id: world.botId(BOT) }, { $set: { cpu: 100, cpuAvailable: 10000 } });
    await world.exec('Game.cpu.halt()');
    await world.tick(4);

    const records = world.report.logs.filter((entry) => /Memory 不可用/.test(String(entry))).map(stackLines);
    const raw = records.find((lines) => lines.some((line) => line.includes('未映射：CPU 保护')));
    const mapped = records.find((lines) => !lines.some((line) => line.includes('未映射')));
    assert.ok(raw, '低 bucket 时应记录未映射的原始堆栈');
    assert.ok(mapped, '换成新 global 且 bucket 充足后应记录映射后的堆栈');

    const rawFrames = raw.filter((line) => /^\s*at\s/.test(line));
    const mappedFrames = mapped.filter((line) => /^\s*at\s/.test(line));
    assert.equal(mappedFrames.length, rawFrames.length, '两次记录的帧数应一致');
    const mainFrames = rawFrames.map((line) => MAIN_FRAME.exec(line)).filter(Boolean);
    assert.ok(mainFrames.length >= 3, `真实堆栈应含 main:<行>:<列> 形式的帧：\n${rawFrames.join('\n')}`);

    let checked = 0;
    rawFrames.forEach((line, index) => {
      const match = MAIN_FRAME.exec(line);
      const where = match ? originalPosition(map, Number(match[3]), Number(match[4])) : undefined;
      if (!match || where === undefined || checked >= MAP_FRAME_LIMIT) {
        assert.equal(mappedFrames[index], line, `没有映射数据的帧应原样保留：${line}`);
        return;
      }
      checked += 1;
      const expected = match[2] ? `${match[1]}${match[2]} (${where})` : `${match[1]}${where}`;
      assert.equal(mappedFrames[index], expected, `第 ${index + 1} 帧的映射应与独立解码一致`);
      // 原始位置落在 bot 实际运行的产物中：首帧是 Error 的构造处，其余帧是调用处。
      const code = main[Number(match[3]) - 1].slice(Number(match[4]) - 1);
      const pattern = index === 0 ? /^new Error\(/ : /^[A-Za-z_$][\w$]*\(/;
      assert.match(code, pattern, `第 ${index + 1} 帧的原始位置应指向${index === 0 ? ' new Error' : '函数调用'}：${code.slice(0, 40)}`);
    });
    assert.ok(checked >= 3, '应至少逐帧核对 3 个映射帧');
    assertRuntimeClean(world.report, { allow: EXPECTED });
    console.log(`PASS: error-mapping（核对 ${checked} 帧；首帧 ${mappedFrames[0].trim()}）`);
  });
}

module.exports = { run };
