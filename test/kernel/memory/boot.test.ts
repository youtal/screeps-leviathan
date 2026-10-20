/** boot 特权端口所需的 Memory 宿主能力：加载时概要、原始文本、sys 访问器与提交校验、整体清空，以及供 segments 使用的合法 epoch。 */
import type { ProjectMarker } from '@/contracts/boot';
import { harness, marker, spec } from './harness';

/**
 * @description 在严格平台替身上驱动一个 tick，容许 beginTick 抛错（加载失败的情形），再运行测试代码。
 * @param h Memory 测试宿主。
 * @param time 本 tick 的 Game.time。
 * @param run 本 tick 内执行的测试代码。
 * @returns 无返回值。
 * @throws {*} 测试代码的异常原样传播。
 */
const tolerant = (h: ReturnType<typeof harness>, time: number, run: () => void): void => {
  const result = h.platform.tick(() => {
    try { h.memory.beginTick({ time, creeps: new Set(), flags: new Set() }); } catch { /* 加载失败由测试断言 */ }
    run();
  });
  if (result.error !== undefined) throw result.error;
};

/**
 * @description 以给定原始文本加载，返回概要。
 * @param text 原始 Memory 文本。
 * @returns 本实例加载时的概要。
 */
const summaryOf = (text: string) => {
  const h = harness(text);
  let summary: ReturnType<typeof h.memory.summary>;
  tolerant(h, 1, () => { summary = h.memory.summary(); });
  return summary!;
};

describe('summary', () => {
  test('空白、{} 与只含空的引擎默认键都是 EMPTY（11.3）', () => {
    for (const text of ['', '  ', '{}', '{"creeps":{},"spawns":{},"rooms":{},"flags":{},"powerCreeps":{}}']) {
      expect(summaryOf(text)).toMatchObject({ empty: true, parsed: true, marker: null });
    }
    expect(summaryOf('{"creeps":{"a":{}}}').empty).toBe(false);
    expect(summaryOf('{"creeps":[]}').empty).toBe(false);
    expect(summaryOf('{"other":{}}')).toMatchObject({ empty: false, parsed: true, rootKeys: ['other'], marker: null });
  });

  test('损坏文本与非对象根为未解析，Memory 锁存失败但概要可用', () => {
    for (const text of ['{oops', '[]', '5', 'null']) {
      const h = harness(text);
      tolerant(h, 1, () => {
        expect(h.memory.failed()).toBe(true);
        expect(h.memory.summary()).toEqual({ empty: false, parsed: false, rootKeys: [], marker: null });
        expect(h.memory.loadedText()).toBe(text);
      });
    }
  });

  test('同 schema 的标记完整校验；不同 schema 只要求签名与 schema；签名不符为 null', () => {
    const ours = JSON.stringify({ x: 1, leviathan: { sys: marker, part: {}, rooms: {}, creeps: {}, flags: {} } });
    const s = summaryOf(ours);
    expect(s).toMatchObject({ empty: false, parsed: true, rootKeys: ['x', 'leviathan'], marker });
    expect(Object.isFrozen(s.marker) && Object.isFrozen(s.marker!.fp.rooms) && Object.isFrozen(s.rootKeys)).toBe(true);
    const broken = { ...marker, epoch: -1 };
    expect(summaryOf(JSON.stringify({ leviathan: { sys: broken } })).marker).toBeNull();
    // 较新的 schema 可能改变标记结构：只保证 sig 与 schema，供 boot 判定 OURS_NEWER。
    const newer = summaryOf(JSON.stringify({ leviathan: { sys: { sig: 'leviathan', schema: 2, fp: 'changed' } } }));
    expect(newer.marker).toEqual({ sig: 'leviathan', schema: 2, fp: 'changed' });
    expect(summaryOf(JSON.stringify({ leviathan: { sys: { ...marker, sig: 'other' } } })).marker).toBeNull();
    expect(summaryOf(JSON.stringify({ leviathan: { sys: { sig: 'leviathan', schema: 'x' } } })).marker).toBeNull();
  });

  test('非空文本只解析一次；概要与原始文本不随后续写入变化', () => {
    const text = JSON.stringify({ x: 1 });
    const h = harness(text);
    const parse = jest.spyOn(JSON, 'parse');
    let before: ReturnType<typeof h.memory.summary>;
    h.tick(1, () => {
      before = h.memory.summary();
      h.memory.initialize(marker);
      h.memory.sys().set(['lastRun'], 9);
      h.memory.commit();
    });
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockRestore();
    h.tick(2, () => {
      expect(h.memory.summary()).toBe(before);
      expect(h.memory.summary()!.marker).toBeNull();
      expect(h.memory.loadedText()).toBe(text);
    });
  });

  test('尚未加载时为未解析；dispose 后释放原始文本', () => {
    const h = harness('{}');
    expect(h.memory.summary()).toEqual({ empty: false, parsed: false, rootKeys: [], marker: null });
    h.tick(1, () => expect(h.memory.loadedText()).toBe('{}'));
    h.memory.dispose();
    expect(h.memory.loadedText()).toBeUndefined();
  });
});

describe('sys', () => {
  test('empty 时不可用；初始化后读写并在提交时写出', () => {
    const h = harness();
    h.tick(1, () => {
      expect(() => h.memory.sys()).toThrow();
      h.memory.initialize(marker);
      const sys = h.memory.sys();
      expect(h.memory.sys()).toBe(sys);
      sys.set(['lastRun'], 5);
      sys.update(['fp'], (fp) => { (fp as { creepCount: number }).creepCount = 2; });
      h.memory.commit();
    });
    const saved = JSON.parse(h.platform.memory).leviathan.sys as ProjectMarker;
    expect(saved.lastRun).toBe(5);
    expect(saved.fp.creepCount).toBe(2);
  });

  test('非法标记沿用上一版写出并只告警一次；修正后写出新值', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.commit(); });
    h.tick(2, () => {
      h.memory.sys().set(['sig'], 'other');
      h.memory.partitions('o').partition('a', spec).set(['n'], 1);
      h.memory.commit();
    });
    let saved = JSON.parse(h.platform.memory).leviathan;
    expect(saved.sys).toEqual(marker);
    expect(saved.part.o.a.data.n).toBe(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][0]).toContain('sys');
    // 只剩被隔离的 sys 时不写入，也不重复告警。
    h.tick(3, () => expect(h.memory.commit()).toBe(false));
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.tick(4, () => {
      h.memory.sys().replace({ ...marker, sig: 'leviathan', epoch: 7 });
      expect(h.memory.commit()).toBe(true);
    });
    saved = JSON.parse(h.platform.memory).leviathan;
    expect(saved.sys.epoch).toBe(7);
    h.tick(5, () => expect(h.memory.commit()).toBe(false));
  });

  test('schema 不符的标记同样被隔离', () => {
    const h = harness();
    h.tick(1, () => {
      h.memory.initialize(marker);
      h.memory.sys().set(['schema'], 2);
      h.memory.commit();
    });
    expect(JSON.parse(h.platform.memory).leviathan.sys.schema).toBe(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});

describe('epoch', () => {
  test('SR-03：只反映合法标记：加载、初始化、清空立即生效，sys 写入经提交成功后生效，隔离期间不变', () => {
    const h = harness();
    h.tick(1, () => {
      expect(h.memory.epoch()).toBe(0); // empty
      h.memory.initialize({ ...marker, epoch: 3 });
      expect(h.memory.epoch()).toBe(3);
      h.memory.commit();
    });
    h.tick(2, () => {
      h.memory.sys().set(['epoch'], -1);
      h.memory.commit(); // 被隔离，沿用上一版
      expect(h.memory.epoch()).toBe(3);
    });
    h.tick(3, () => {
      h.memory.sys().set(['epoch'], 9);
      expect(h.memory.epoch()).toBe(3); // 提交前仍是已写出的值
      h.memory.commit();
      expect(h.memory.epoch()).toBe(9);
    });
    h.tick(4, () => {
      h.memory.clear({ ...marker, epoch: 12 });
      expect(h.memory.epoch()).toBe(12);
      h.memory.commit();
    });
    const reloaded = harness(h.platform.memory);
    reloaded.tick(5, () => expect(reloaded.memory.epoch()).toBe(12));
    h.memory.dispose();
    expect(h.memory.epoch()).toBe(0);
  });
});

describe('clear', () => {
  test('替换整个根、丢弃外来键与旧访问器，sys 访问器继续指向新标记', () => {
    const h = harness(JSON.stringify({ foreign: { a: 1 } }));
    let old: ReturnType<ReturnType<typeof h.memory.partitions>['partition']>;
    let sys: ReturnType<typeof h.memory.sys>;
    h.tick(1, () => {
      h.memory.initialize(marker);
      old = h.memory.partitions('o').partition('a', spec);
      old.set(['n'], 3);
      sys = h.memory.sys();
      h.memory.commit();
    });
    h.tick(2, () => {
      h.memory.clear({ ...marker, epoch: 1 });
      expect(() => old.root()).toThrow('访问器已失效');
      expect(sys.get(['epoch'])).toBe(1);
      expect(h.memory.partitions('o').partition('a', spec).get(['n'])).toBe(0);
      h.memory.commit();
    });
    const saved = JSON.parse(h.platform.memory);
    expect(Object.keys(saved)).toEqual(['leviathan']);
    expect(saved.leviathan.sys.epoch).toBe(1);
    expect(saved.leviathan.part.o.a.data.n).toBe(0);
  });

  test('解除加载失败的锁存，下一次提交写出新根', () => {
    const h = harness('{broken');
    tolerant(h, 1, () => {
      expect(h.memory.failed()).toBe(true);
      expect(h.memory.ready()).toBe(false);
      h.memory.clear(marker);
      expect(h.memory.failed()).toBe(false);
      expect(h.memory.ready()).toBe(true);
      h.memory.sys().set(['lastRun'], 1);
      h.memory.commit();
    });
    expect(JSON.parse(h.platform.memory)).toEqual({ leviathan: { sys: { ...marker, lastRun: 1 },
      part: {}, rooms: {}, creeps: {}, flags: {} } });
  });

  test('非法标记或首个 tick 前调用时抛错且不改变状态', () => {
    const h = harness(JSON.stringify({ foreign: 1 }));
    expect(() => h.memory.clear(marker)).toThrow('不可清空');
    h.tick(1, () => {
      expect(() => h.memory.clear({ ...marker, sig: 'other' })).toThrow('清空标记不匹配');
      expect(h.memory.ready()).toBe(false);
      h.memory.initialize(marker);
      h.memory.commit();
    });
    expect(JSON.parse(h.platform.memory).foreign).toBe(1);
  });

  test('清空时 sys 的隔离状态被清除，新标记作为合法基线', () => {
    const h = harness();
    h.tick(1, () => {
      h.memory.initialize(marker);
      h.memory.sys().set(['sig'], 'bad');
      h.memory.commit();
    });
    h.tick(2, () => {
      h.memory.clear({ ...marker, epoch: 4 });
      h.memory.commit();
    });
    expect(JSON.parse(h.platform.memory).leviathan.sys.epoch).toBe(4);
  });
});
