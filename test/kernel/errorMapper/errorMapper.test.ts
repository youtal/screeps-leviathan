/**
 * 文件摘要：kernel.errorMapper（src/kernel/errorMapper/）的单元测试。
 * VLQ 测试向量按 Source Map v3 规则手算：生成列在每个 `;` 处归零，其余字段跨行延续；覆盖负增量、多字符 VLQ、
 * 多源文件与 1 值段。errorMapper 测试覆盖帧映射、帧数上限、CPU 保护、映射不可用、只解码一次、缓存与淘汰、
 * 非 Error 抛出值及访问器抛错。
 */
import { ERROR_MAP_BUCKET, createErrorMapper } from '@/kernel/errorMapper';
import { decodeMappings, lookup } from '@/kernel/errorMapper/vlq';

describe('decodeMappings 与 lookup', () => {
  // 第 0 行 AAAA：[0,0,0,0]。第 1 行 AACA：[0,0,+1,0]；EAAE：[+2,0,0,+2]。
  // 第 2 行 AACD：生成列从 0 重新起算，原始行 +1、原始列 -1（D 为 -1）。
  const lines = decodeMappings('AAAA;AACA,EAAE;AACD');

  test('生成列每行归零，源文件、原始行列跨行延续', () => {
    expect(Array.from(lines[1])).toEqual([0, 0, 1, 0, 2, 0, 1, 2]);
    expect(Array.from(lines[2])).toEqual([0, 0, 2, 1]);
    expect(lookup(lines, 2, 0)).toEqual({ source: 0, line: 2, column: 1 });
  });

  test('按列查找不大于目标列的最近段', () => {
    expect(lookup(lines, 1, 1)).toEqual({ source: 0, line: 1, column: 0 });
    expect(lookup(lines, 1, 9)).toEqual({ source: 0, line: 1, column: 2 });
    expect(lookup(lines, 5, 0)).toBeNull();
  });

  test('多字符 VLQ、多源文件与只有 1 个值的段', () => {
    // gB = 16；ACAA 使源文件索引 +1；G = 3 的 1 值段没有源码位置。
    const decoded = decodeMappings('gBAAA,ACAA,G');
    expect(Array.from(decoded[0])).toEqual([16, 0, 0, 0, 16, 1, 0, 0, 19, -1, 0, 0]);
    expect(lookup(decoded, 0, 17)).toEqual({ source: 1, line: 0, column: 0 });
    expect(lookup(decoded, 0, 25)).toBeNull();
  });

  test('非法字符、未结束的 VLQ 与非法值个数报错', () => {
    expect(() => decodeMappings('AA*A')).toThrow('非法 Base64');
    expect(() => decodeMappings('g')).toThrow('VLQ 未结束');
    expect(() => decodeMappings('AA')).toThrow('值个数非法');
  });
});

describe('createErrorMapper', () => {
  // 第 0 行映射到 src/kernel/a.ts:1:1；第 1 行列 4 的段 ICAE 映射到 src/main.ts:2:3。
  const map = { version: 3, sources: ['../src/kernel/a.ts', '../src/main.ts'], mappings: 'AAAA;AACA,ICAE' };

  /**
   * @description 创建可观测的 errorMapper。
   * @param overrides 覆盖默认选项：loadMap、bucket、remaining。
   * @returns errorMapper 与各端口的 mock。
   */
  const setup = (overrides: Partial<{ loadMap: () => unknown; bucket: () => number; remaining: () => number }> = {}) => {
    const loadMap = jest.fn(overrides.loadMap ?? (() => map));
    const bucket = jest.fn(overrides.bucket ?? (() => 10000));
    const remaining = jest.fn(overrides.remaining ?? (() => 10));
    return { mapper: createErrorMapper({ loadMap, bucket, remaining }), loadMap, bucket, remaining };
  };

  /**
   * @description 构造带指定堆栈的 Error。
   * @param stack 堆栈文本。
   * @returns Error 对象。
   */
  const withStack = (stack: string): Error => Object.assign(new Error('boom'), { stack });

  const raw = 'Error: boom\n    at loop (main:2:5)\n    at main:1:1\n    at other (other:1:1)';

  test('映射 main 模块的帧，路径规范为 src/...，其余帧原样保留', () => {
    const { mapper } = setup();
    expect(mapper.format(withStack(raw)))
      .toBe('Error: boom\n    at loop (src/main.ts:2:3)\n    at src/kernel/a.ts:1:1\n    at other (other:1:1)');
  });

  test('每条堆栈最多映射前 10 帧', () => {
    const { mapper } = setup();
    const frames = Array.from({ length: 12 }, () => '    at f (main:1:1)');
    const lines = mapper.format(withStack(['Error: x', ...frames].join('\n'))).split('\n');
    expect(lines.slice(1, 11).every((l) => l.includes('src/kernel/a.ts'))).toBe(true);
    expect(lines.slice(11)).toEqual(['    at f (main:1:1)', '    at f (main:1:1)']);
  });

  test.each([
    ['bucket 不足', { bucket: () => ERROR_MAP_BUCKET - 1 }],
    ['本 tick 余量不足', { remaining: () => 0 }],
  ])('%s时不解码、不映射，注明未映射', (_label, overrides) => {
    const { mapper, loadMap } = setup(overrides);
    expect(mapper.format(withStack(raw))).toBe(`${raw}\n（未映射：CPU 保护）`);
    expect(loadMap).not.toHaveBeenCalled();
  });

  test('source map 不可用时输出原始堆栈，本 global 不再尝试加载', () => {
    const { mapper, loadMap } = setup({ loadMap: () => { throw new Error('no module'); } });
    expect(mapper.format(withStack(raw))).toBe(raw);
    expect(mapper.format(withStack(`${raw}\n`))).toBe(`${raw}\n`);
    expect(loadMap).toHaveBeenCalledTimes(1);
  });

  test('只解码一次；同一堆栈命中缓存，不再检查 CPU；超过 50 条时淘汰最早的一条', () => {
    const { mapper, loadMap, bucket } = setup();
    const first = withStack(raw);
    mapper.format(first);
    mapper.format(withStack(raw.replace('main:2:5', 'main:2:6')));
    expect(loadMap).toHaveBeenCalledTimes(1);
    bucket.mockClear();
    mapper.format(first);
    expect(bucket).not.toHaveBeenCalled();
    for (let i = 0; i < 50; i += 1) mapper.format(withStack(`${raw}\n    at n${i} (main:1:1)`));
    mapper.format(first);
    expect(bucket).toHaveBeenCalled();
  });

  test('没有 main 帧的堆栈直接返回，不检查 CPU', () => {
    const { mapper, bucket } = setup();
    expect(mapper.format(withStack('Error: x\n    at f (other:1:1)'))).toBe('Error: x\n    at f (other:1:1)');
    expect(bucket).not.toHaveBeenCalled();
  });

  test('非 Error 抛出值与读取堆栈时抛错的 Error', () => {
    const { mapper } = setup();
    expect(mapper.format('文本')).toBe('非 Error 抛出值：文本');
    expect(mapper.format(42)).toBe('非 Error 抛出值：42');
    const broken = new Error('坏的');
    Object.defineProperty(broken, 'stack', { get: () => { throw new Error('getter'); } });
    expect(mapper.format(broken)).toBe('Error: 坏的');
  });
});
