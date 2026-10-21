/**
 * 文件摘要：inspector（scripts/inspector/lib.ts）的单元测试，以构造的接口响应驱动，不访问网络。
 * 覆盖：参数解析；Memory 响应的 gzip 与 base64 解码及各种失败；Memory 状态与 kernel.memory 的 summarize、
 * app.boot 的 memoryView 在同一输入上一致（规则各实现一份，防止走样）；身份、模式集合、页号分配与 Memory 上限
 * 这些手抄常量与游戏内的来源一致；单元体积统计；值与页正文的截断；segment 页的解码（复用 kernel.segments 的页格式），
 * 以及统计页与备份页的格式说明。
 */
import { gzipSync } from 'node:zlib';
import { BOOT_MODES, memoryView } from '@/app/boot/assess';
import { MEMORY_IDENTITY } from '@/app/assembly';
import { MEMORY_LIMIT as KERNEL_MEMORY_LIMIT } from '@/kernel/memory/commit';
import { summarize } from '@/kernel/memory/marker';
import { STORES } from '@/kernel/segments';
import { encodePage } from '@/kernel/segments/page';
import {
  IDENTITY, MEMORY_LIMIT, MODES, OUTPUT_LIMIT, PAGE_STORES, decodeMemoryData, formatMarker, formatSegment, formatSizes, formatValue, memoryState,
  parseInspectArgs, unitSizes,
} from '../../scripts/inspector/lib';
import { marker } from '../kernel/lifecycle/harness';

/**
 * @description 按服务器的方式编码 Memory 接口的 data 字段。
 * @param value 任意 JSON 值。
 * @returns `'gz:' + base64(gzip(JSON))`。
 */
const gz = (value: unknown): string => `gz:${gzipSync(JSON.stringify(value)).toString('base64')}`;

describe('parseInspectArgs', () => {
  test('各命令的参数与必需项', () => {
    expect(parseInspectArgs(['marker', '--account', 'main'])).toEqual({ command: 'marker', account: 'main', shard: undefined, path: undefined, segment: undefined });
    expect(parseInspectArgs(['get', 'leviathan.sys', '--account', 'main', '--shard', 'shard3']))
      .toMatchObject({ command: 'get', path: 'leviathan.sys', shard: 'shard3' });
    expect(parseInspectArgs(['segment', '80', '--account', 'main'])).toMatchObject({ command: 'segment', segment: 80 });
    expect(() => parseInspectArgs(['marker'])).toThrow('--account');
    expect(() => parseInspectArgs(['write', '--account', 'main'])).toThrow('用法');
    expect(() => parseInspectArgs(['get', '--account', 'main'])).toThrow('用法');
    expect(() => parseInspectArgs(['segment', '100', '--account', 'main'])).toThrow('0–99');
  });
  test('页号只接受 0–99 的十进制整数；空串、十六进制、指数与带空白的写法被拒绝，负数报告用法', () => {
    for (const bad of ['', '0x10', '1e1', ' 5', '5.0', '007']) {
      expect(() => parseInspectArgs(['segment', bad, '--account', 'main'])).toThrow('0–99');
    }
    expect(() => parseInspectArgs(['segment', '-1', '--account', 'main'])).toThrow('用法');
  });
});

describe('decodeMemoryData', () => {
  test('解码 gzip 与 base64；路径不存在、服务器无法解析与格式未知分别报告', () => {
    expect(decodeMemoryData(gz({ a: 1 }))).toEqual({ status: 'value', value: { a: 1 } });
    expect(decodeMemoryData(undefined)).toEqual({ status: 'missing' });
    expect(decodeMemoryData('Incorrect memory path')).toMatchObject({ status: 'unreadable' });
    expect(decodeMemoryData('plain')).toMatchObject({ status: 'unreadable', reason: '响应格式未知' });
    expect(decodeMemoryData('gz:不是base64')).toMatchObject({ status: 'unreadable' });
  });
});

describe('Memory 状态', () => {
  test('手抄常量与游戏内的来源一致：身份、模式集合、页号分配与 Memory 上限', () => {
    expect(IDENTITY).toEqual(MEMORY_IDENTITY);
    expect(MODES).toEqual(new Set(BOOT_MODES));
    expect(PAGE_STORES).toEqual(new Map(Object.entries(STORES).flatMap(([name, store]) => store.pages.map((id) => [id, name]))));
    expect(MEMORY_LIMIT).toBe(KERNEL_MEMORY_LIMIT);
  });

  test('与 kernel 的 summarize 及 app.boot 的 memoryView 在同一输入上结论一致', () => {
    const ns = (sys: unknown) => ({ leviathan: { sys, part: {}, rooms: {}, creeps: {}, flags: {} } });
    const fixtures: Record<string, unknown> = {
      空对象: {},
      引擎默认键: { creeps: {}, spawns: {}, rooms: {}, flags: {}, powerCreeps: {} },
      引擎键非空: { creeps: { a: {} } },
      外来根键: { other: 1 },
      签名不符: ns({ ...marker, sig: 'other' }),
      标记合法: ns(marker),
      字段缺失: ns({ ...marker, fp: undefined }),
      模式非法: ns({ ...marker, mode: { ...marker.mode, mode: 'BOGUS' } }),
      较新schema: ns({ sig: 'leviathan', schema: 2 }),
      较旧schema: ns({ ...marker, schema: 0 }),
      根为数组: [1, 2],
    };
    for (const [name, root] of Object.entries(fixtures)) {
      const json = JSON.parse(JSON.stringify(root)) as unknown;
      const summary = summarize(json, MEMORY_IDENTITY.namespace, MEMORY_IDENTITY);
      // memoryView 的 current 是可加载时的标记：schema 与代码相同且标记合法即视为可加载（其余单元的加载不在此比较）。
      const current = summary.marker && summary.marker.schema === MEMORY_IDENTITY.schema ? summary.marker : null;
      const expected = memoryView({ summary, current: current as never, namespace: MEMORY_IDENTITY.namespace, schema: MEMORY_IDENTITY.schema }).state;
      expect({ name, state: memoryState({ status: 'value', value: json }).state }).toEqual({ name, state: expected });
    }
  });

  test('marker 输出：状态、各字段；服务器无法解析时说明原因', () => {
    const text = formatMarker(decodeMemoryData(gz({ leviathan: { sys: marker } })));
    expect(text).toContain('Memory 状态：OURS');
    expect(text).toContain('epoch：0');
    expect(formatMarker(decodeMemoryData(gz({ other: 1 })))).toContain('没有本项目的项目标记');
    expect(formatMarker(decodeMemoryData('Incorrect memory path'))).toContain('无法读取');
  });
});

describe('体积与输出', () => {
  test('按单元统计长度并降序排列；其他根键各计一项', () => {
    const unit = { version: 1, data: { n: 'x'.repeat(50) } };
    const root = { other: { a: 1 }, leviathan: { sys: marker, part: { boot: { control: unit } }, rooms: {}, creeps: { c1: { m: { version: 1, data: {} } } }, flags: {} } };
    const sizes = unitSizes(root);
    expect(sizes[0].path).toBe('leviathan.sys');
    expect(sizes.map((s) => s.path)).toEqual(expect.arrayContaining(['leviathan.part.boot.control', 'leviathan.creeps.c1.m', 'other']));
    expect(sizes.find((s) => s.path === 'leviathan.part.boot.control')!.length).toBe(JSON.stringify(unit).length);
    expect(formatSizes(decodeMemoryData(gz(root)))).toContain(`Memory 总长度 ${JSON.stringify(root).length} 个字符`);
  });
  test('根不是对象时 sizes 报告 CORRUPT，与 marker 一致，而不是报告为空', () => {
    for (const root of [[1, 2], 42, 'text']) {
      expect(formatSizes(decodeMemoryData(gz(root)))).toContain('CORRUPT');
      expect(formatMarker(decodeMemoryData(gz(root)))).toContain('CORRUPT');
    }
  });

  test('get：值格式化输出，过长时截断并注明总长度；路径不存在时说明', () => {
    expect(formatValue('a', { status: 'value', value: { b: 1 } })).toBe('{\n  "b": 1\n}');
    const long = formatValue('a', { status: 'value', value: 'y'.repeat(OUTPUT_LIMIT + 10) });
    expect(long).toContain('已截断');
    expect(formatValue('a.b', { status: 'missing' })).toBe('a.b 不存在');
  });

  test('segment：解出页头并标明已知页号的用途；空页与外来格式分别说明', () => {
    const page = encodePage({ v: 1, o: 'backup', g: 3, e: 2, i: 0, n: 2 }, 'BODY');
    const text = formatSegment(80, page);
    expect(text).toContain('Memory 备份区');
    expect(text).toContain('owner backup');
    expect(text).toContain('批次内第 1/2 页');
    expect(text.endsWith('BODY')).toBe(true);
    expect(formatSegment(50, '')).toContain('为空');
    expect(formatSegment(7, 'foreign')).toContain('不是本项目的页格式');
  });
  test('segment：统计页的正文按 JSON 格式化，备份页说明段序与拼接方式', () => {
    const stats = formatSegment(50, encodePage({ v: 1, o: 'stats', g: 1, e: 1, i: 0, n: 1 }, '{"cpu":{"used":3}}'));
    expect(stats).toContain('正文为统计 JSON');
    expect(stats).toContain('"used": 3');
    expect(formatSegment(50, encodePage({ v: 1, o: 'stats', g: 1, e: 1, i: 0, n: 1 }, 'not json'))).toContain('不是合法的 JSON');
    const backup = formatSegment(81, encodePage({ v: 1, o: 'backup', g: 7, e: 2, i: 1, n: 3 }, 'PART'));
    expect(backup).toContain('第 2 段（共 3 段）');
    expect(backup).toContain('generation 7 的 3 页');
  });
});
