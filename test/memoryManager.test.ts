/**
 * 文件摘要：验证 MemoryManager 的同步申请、长期访问器、深路径读写、分区片段提交、兼容装载与生命周期恢复。
 *
 * 覆盖模块：`src/core/memoryManager` 与契约 `src/contracts/memory.ts`，对应设计 §10 的验收清单：
 * 1. 申请与身份——多 owner/localId、迟到申请、重复/冲突声明、初始化与业务迁移、失败缓存；
 * 2. 提交——只编码脏分区、同 tick 合并、clean tick 零工作、失败保留脏集合并合并重试、容量；
 * 3. 深路径——读取、写入边界、JSON 校验、祖先引用、remove、回调语义与重入；
 * 4. 收尾校验——needsFullValidation 的置位/保留/清除，非法数据阻断整体写盘；
 * 5. 兼容——schemaVersion 2/1、旧 leviathan 导入、Segment 身份忽略、历史 payload 保留、dataVersion 0；
 * 6. 生命周期——tick 校验、重复 begin/end、遗漏 end、硬终止（vm 超时跳过 finally）后的恢复。
 *
 * 替代实现：假平台提供主存储文本、当前 tick 与写入/读取计数，不需要 Screeps 全局对象。
 * 硬终止用 `vm.runInNewContext` 的 timeout 模拟：V8 终止执行时不运行 catch/finally，
 * 与引擎 CPU 硬终止后 heap 保留的情形一致。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不读写真实游戏存储。
 */
import { runInNewContext } from 'node:vm';
import {
  createMemoryManager as createCoreMemoryManager,
  type MemoryManager,
  type MemoryPlatform,
} from '@/core/memoryManager';
import { createLogging } from '@/core/logger';
import type { MemoryAccessor, MemoryApplicationOptions } from '@/contracts/memory';

/** 假平台：整串 raw、可控 tick、写入失败注入与调用计数。 */
const createPlatform = (initial = '') => {
  const state = {
    raw: initial,
    tick: 1,
    writes: 0,
    reads: 0,
    failWrite: null as Error | null,
    onWrite: null as (() => void) | null,
  };
  const platform: MemoryPlatform = {
    readRaw: () => {
      state.reads++;
      return state.raw;
    },
    writeRaw: (value) => {
      state.onWrite?.();
      if (state.failWrite) throw state.failWrite;
      state.writes++;
      state.raw = value;
    },
    getTick: () => state.tick,
  };
  return { platform, state };
};

/** 日志收集器：用于断言告警只出现一次等行为。 */
const createLogs = () => {
  const lines: string[] = [];
  const logging = createLogging({
    levels: { debug: true, info: true },
    output: { write: (line) => lines.push(line), notify: () => undefined },
  });
  return { logging, lines };
};

type Plat = ReturnType<typeof createPlatform>;

const setup = (initial = '') => {
  const plat = createPlatform(initial);
  const logs = createLogs();
  const manager = createCoreMemoryManager({ logging: logs.logging, platform: plat.platform });
  /** 开启 tick：设置真实 tick 并 begin。 */
  const begin = (tick = plat.state.tick) => {
    plat.state.tick = tick;
    manager.begin(tick);
  };
  const end = () => manager.end(plat.state.tick);
  /** 完整跑一个 tick：begin → body → end，然后推进 tick。 */
  const tick = (body: () => void = () => undefined) => {
    begin();
    try {
      body();
    } finally {
      end();
      plat.state.tick++;
    }
  };
  return { plat, logs, manager, begin, end, tick, bind: manager.bind };
};

/** 读取已写出的命名空间。 */
const stored = (plat: Plat) => JSON.parse(plat.state.raw);
const partitionOf = (plat: Plat, owner: string, localId: string) =>
  stored(plat).memoryManager.partitions[owner][localId];

/** 以当前 raw 模拟 global reset：新管理器、同一平台状态。 */
const reset = (plat: Plat) => {
  const logs = createLogs();
  const manager = createCoreMemoryManager({ logging: logs.logging, platform: plat.platform });
  return { manager, logs };
};

interface Counter {
  count: number;
  tags?: Record<string, { level: number; note?: string }>;
  list?: number[];
  nested?: { deep: { value: number } };
}
const counterInit = () => ({ count: 0 }) as Counter;
const counterOptions: MemoryApplicationOptions<Counter> = {
  version: 1,
  initialize: counterInit,
};

describe('MemoryManager application', () => {
  it('initializes, persists and restores partitions across a global reset', () => {
    const t = setup();
    let accessor!: MemoryAccessor<Counter>;
    t.tick(() => {
      accessor = t.bind('alpha')('main', counterOptions);
      accessor.commit('count', 3);
    });
    expect(partitionOf(t.plat, 'alpha', 'main')).toEqual({
      dataVersion: 1,
      payload: { count: 3 },
    });
    // 访问器跨 tick 直接可用，不需要重新 access。
    t.tick(() => accessor.commit('count', accessor.get('count')! + 1));
    expect(partitionOf(t.plat, 'alpha', 'main').payload.count).toBe(4);

    const { manager } = reset(t.plat);
    manager.begin(t.plat.state.tick);
    const initialize = jest.fn(counterInit);
    const restored = manager.bind('alpha')('main', { version: 1, initialize });
    expect(restored.query().count).toBe(4);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('keeps owners and localIds independent, allows late applications and keeps unapplied history', () => {
    const t = setup();
    t.tick(() => {
      t.bind('a')('x', counterOptions).commit('count', 1);
      t.bind('a')('y', counterOptions).commit('count', 2);
      t.bind('b')('x', counterOptions).commit('count', 3);
    });
    const { manager } = reset(t.plat);
    const plat = t.plat;
    // 新 global 只申请 a/x；a/y 与 b/x 的历史片段必须原样参与输出。
    plat.state.tick = 10;
    manager.begin(10);
    manager.bind('a')('x', counterOptions).commit('count', 9);
    manager.end(10);
    // 迟到申请：几个 tick 后才申请 b/x。
    for (let tick = 11; tick < 14; tick++) {
      plat.state.tick = tick;
      manager.begin(tick);
      manager.end(tick);
    }
    plat.state.tick = 14;
    manager.begin(14);
    expect(manager.bind('b')('x', counterOptions).query().count).toBe(3);
    manager.end(14);
    const partitions = stored(plat).memoryManager.partitions;
    expect(partitions.a.x.payload.count).toBe(9);
    expect(partitions.a.y.payload.count).toBe(2);
    expect(partitions.b.x.payload.count).toBe(3);
  });

  it('returns the same accessor for the same declaration and rejects conflicts', () => {
    const t = setup();
    t.tick(() => {
      const first = t.bind('a')('main', counterOptions);
      expect(t.bind('a')('main', counterOptions)).toBe(first);
      expect(() => t.bind('a')('main', { version: 2, initialize: counterInit })).toThrow(
        /conflicting declaration/
      );
      expect(() => t.bind('a')('main', { version: 1, initialize: () => ({ count: 0 }) })).toThrow(
        /conflicting declaration/
      );
    });
  });

  it('rejects invalid identities, options and application outside the write phase', () => {
    const t = setup();
    expect(() => t.bind('a')('main', counterOptions)).toThrow(/between a successful begin/);
    t.tick(() => {
      expect(() => t.bind('bad owner')('main', counterOptions)).toThrow(/invalid owner/);
      expect(() => t.bind('a')('__proto__', counterOptions)).toThrow(/invalid localId/);
      expect(() => t.bind('a')('main', { version: 0, initialize: counterInit })).toThrow(
        /positive integer/
      );
      expect(() =>
        t.bind('a')('main', { version: 1, layer: 'critical', initialize: counterInit } as any)
      ).toThrow(/layer is no longer supported/);
      expect(() => t.bind('a')('main', { version: 1 } as any)).toThrow(/initialize must be a function/);
    });
    expect(() => t.bind('a')('late', counterOptions)).toThrow(/between a successful begin/);
  });

  it('validates initialize results and rejects asynchronous callbacks', () => {
    const t = setup();
    t.tick(() => {
      const cases: [string, () => unknown, RegExp][] = [
        ['array', () => [], /plain object/],
        ['undef', () => ({ a: undefined }), /undefined is not a JSON value/],
        ['nan', () => ({ a: NaN }), /non-finite/],
        ['map', () => ({ a: new Map() }), /non-plain object/],
        ['date', () => ({ a: new Date() }), /non-plain object/],
        ['fn', () => ({ a: () => 1 }), /function is not a JSON value/],
        ['sparse', () => ({ a: [1, , 3] }), /sparse/],
        ['getter', () => ({ get a() { return 1; } }), /accessor property/],
        ['reserved', () => JSON.parse('{"__proto__":{}}'), /reserved key/],
        ['async', () => Promise.resolve({}), /synchronous/],
      ];
      for (const [id, initialize, error] of cases)
        expect(() => t.bind('a')(id, { version: 1, initialize: initialize as any })).toThrow(error);
      const cyclic: any = { a: {} };
      cyclic.a.self = cyclic;
      expect(() => t.bind('a')('cycle', { version: 1, initialize: () => cyclic })).toThrow(
        /circular/
      );
      const shared = { v: 1 };
      expect(
        t.bind('a')('shared', { version: 1, initialize: () => ({ x: shared, y: shared }) }).query()
      ).toEqual({ x: { v: 1 }, y: { v: 1 } });
    });
    expect(t.manager.getStatus().partitions.map((p) => p.localId)).toEqual(['shared']);
  });

  it('migrates isolated copies, caches failures and never falls back to initialize', () => {
    const t = setup();
    t.tick(() => t.bind('a')('main', counterOptions).commit('count', 5));
    const before = t.plat.state.raw;

    const { manager } = reset(t.plat);
    const plat = t.plat;
    manager.begin(plat.state.tick);
    const initialize = jest.fn(counterInit);
    // 缺少 migrate：拒绝，不初始化为空。
    expect(() => manager.bind('a')('main', { version: 2, initialize })).toThrow(
      /missing migrate for stored dataVersion 1/
    );
    // migrate 修改隔离副本后抛错：历史片段不受污染，相同声明不重跑。
    const failing = jest.fn((memory: any) => {
      memory.count = -1;
      throw new Error('boom');
    });
    const failingOptions = { version: 2, initialize, migrate: failing };
    expect(() => manager.bind('a')('main', failingOptions)).toThrow(/boom/);
    expect(() => manager.bind('a')('main', failingOptions)).toThrow(/boom/);
    expect(failing).toHaveBeenCalledTimes(1);
    manager.end(plat.state.tick);
    expect(plat.state.raw).toBe(before);

    // 修复后的声明可重新申请；降级同样要求显式 migrate。
    plat.state.tick++;
    manager.begin(plat.state.tick);
    const migrate = jest.fn((memory: any, from: number) => ({ count: memory.count * 10 + from }));
    const migrated = manager.bind('a')('main', { version: 2, initialize, migrate });
    expect(migrated.query().count).toBe(51);
    expect(initialize).not.toHaveBeenCalled();
    manager.end(plat.state.tick);
    expect(partitionOf(plat, 'a', 'main')).toEqual({ dataVersion: 2, payload: { count: 51 } });
  });

  it('rejects same-version stored data that is not managed and repairs it through migrate', () => {
    const history = JSON.stringify({
      memoryManager: {
        schemaVersion: 2,
        partitions: { a: { list: { dataVersion: 1, payload: [1, 2] }, nul: { dataVersion: 1, payload: null } } },
      },
    });
    const t = setup(history);
    t.tick(() => {
      expect(() => t.bind('a')('list', counterOptions)).toThrow(/not managed data/);
      expect(() => t.bind('a')('nul', counterOptions)).toThrow(/not managed data/);
      const repaired = t.bind('a')('list', {
        version: 2,
        initialize: counterInit,
        migrate: (memory) => ({ count: (memory as number[]).length }),
      });
      expect(repaired.query()).toEqual({ count: 2 });
    });
    const partitions = stored(t.plat).memoryManager.partitions;
    expect(partitions.a.list).toEqual({ dataVersion: 2, payload: { count: 2 } });
    expect(partitions.a.nul).toEqual({ dataVersion: 1, payload: null });
  });
});

describe('MemoryManager commit', () => {
  it('encodes only dirty partitions, merges commits and does nothing on clean ticks', () => {
    const t = setup();
    let a!: MemoryAccessor<Counter>;
    let b!: MemoryAccessor<Counter>;
    t.tick(() => {
      a = t.bind('owner')('a', counterOptions);
      b = t.bind('owner')('b', counterOptions);
    });
    const stringify = jest.spyOn(JSON, 'stringify');
    const parse = jest.spyOn(JSON, 'parse');
    try {
      t.tick(() => {
        a.commit('count', 1);
        a.commit('count', 2);
        a.commit((memory) => void (memory.count += 1));
      });
      const encodedData = stringify.mock.calls.map((call) => call[0]);
      expect(encodedData.filter((value) => value === a.query())).toHaveLength(1);
      expect(encodedData.filter((value) => value === b.query())).toHaveLength(0);
      expect(partitionOf(t.plat, 'owner', 'a').payload.count).toBe(3);

      stringify.mockClear();
      parse.mockClear();
      const writes = t.plat.state.writes;
      t.tick();
      t.tick();
      expect(stringify).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(t.plat.state.writes).toBe(writes);
    } finally {
      stringify.mockRestore();
      parse.mockRestore();
    }
  });

  it('commits initialization together with same-tick modifications', () => {
    const t = setup();
    t.tick(() => {
      const accessor = t.bind('a')('main', counterOptions);
      accessor.commit('count', 7);
    });
    expect(t.plat.state.writes).toBe(1);
    expect(partitionOf(t.plat, 'a', 'main').payload.count).toBe(7);
  });

  it('keeps dirty state on platform failure and merges retries with new modifications', () => {
    const t = setup();
    let a!: MemoryAccessor<Counter>;
    t.tick(() => {
      a = t.bind('o')('a', counterOptions);
    });
    const committed = t.plat.state.raw;
    t.plat.state.failWrite = new Error('disk full');
    t.tick(() => a.commit('count', 1));
    expect(t.plat.state.raw).toBe(committed);
    let status = t.manager.getStatus();
    expect(status.rawWriteError).toBe('platform: disk full');
    expect(status.writeFailure).toMatchObject({ stage: 'platform' });
    expect(status.dirty).toEqual([{ owner: 'o', localId: 'a' }]);

    t.plat.state.failWrite = null;
    let b!: MemoryAccessor<Counter>;
    t.tick(() => {
      a.commit('count', 2);
      b = t.bind('o')('b', counterOptions);
      b.commit('count', 5);
    });
    status = t.manager.getStatus();
    expect(status.rawWriteError).toBeNull();
    expect(status.dirty).toEqual([]);
    expect(partitionOf(t.plat, 'o', 'a').payload.count).toBe(2);
    expect(partitionOf(t.plat, 'o', 'b').payload.count).toBe(5);
    expect(t.logs.lines.filter((line) => line.includes('memory commit failed'))).toHaveLength(1);
  });

  it('rejects oversized text as a whole and recovers after shrinking', () => {
    const t = setup();
    let a!: MemoryAccessor<{ blob: string }>;
    let b!: MemoryAccessor<Counter>;
    t.tick(() => {
      a = t.bind('o')('a', { version: 1, initialize: () => ({ blob: '' }) });
      b = t.bind('o')('b', counterOptions);
    });
    const committed = t.plat.state.raw;
    t.tick(() => {
      a.commit('blob', 'x'.repeat(2_200_000));
      b.commit('count', 1);
    });
    expect(t.plat.state.raw).toBe(committed);
    const failure = t.manager.getStatus().writeFailure!;
    expect(failure.stage).toBe('capacity');
    expect(failure.owner).toBeUndefined();
    t.tick(() => a.commit('blob', 'small'));
    expect(partitionOf(t.plat, 'o', 'a').payload.blob).toBe('small');
    expect(partitionOf(t.plat, 'o', 'b').payload.count).toBe(1);
  });

  it('escapes owner, localId and record keys in the assembled text', () => {
    const t = setup(JSON.stringify({ 'quote"key': { 'x\ny': 1 } }));
    t.tick(() => {
      t.bind('a.b-c')('main_1', {
        version: 1,
        initialize: () => ({ 'dotted.key': 1, 'quo"te': ' ' }),
      });
    });
    const root = stored(t.plat);
    expect(root['quote"key']).toEqual({ 'x\ny': 1 });
    expect(root.memoryManager.partitions['a.b-c'].main_1.payload).toEqual({
      'dotted.key': 1,
      'quo"te': ' ',
    });
  });
});

describe('MemoryManager deep paths', () => {
  const withState = (body: (accessor: MemoryAccessor<Counter>, t: ReturnType<typeof setup>) => void) => {
    const t = setup();
    t.tick(() => {
      const accessor = t.bind('o')('main', {
        version: 1,
        initialize: () => ({
          count: 0,
          tags: { W1N1: { level: 1 } },
          list: [1, 2, 3],
          nested: { deep: { value: 1 } },
        }),
      });
      body(accessor, t);
    });
    return t;
  };

  it('reads keys and paths with missing and mismatch semantics', () => {
    withState((m) => {
      const anyM = m as MemoryAccessor<any>;
      expect(m.get('count')).toBe(0);
      expect(m.get(['tags', 'W1N1', 'level'])).toBe(1);
      expect(m.get(['tags', 'W2N2', 'level'])).toBeUndefined();
      expect(m.get(['list', 7])).toBeUndefined();
      expect(() => anyM.get(['count', 'x'])).toThrow(/cannot traverse number/);
      expect(() => anyM.get(['list', 'length'])).toThrow(/numeric index/);
      expect(() => anyM.get(['tags', 0])).toThrow(/string key/);
      expect(() => anyM.get([])).toThrow(/non-empty/);
      expect(() => anyM.get(['tags', '__proto__'])).toThrow(/reserved key/);
      expect(() => anyM.get(['list', -1])).toThrow(/not a key or index/);
      expect(() => anyM.get(['list', 1.5])).toThrow(/not a key or index/);
    });
  });

  it('writes complete values, requires existing containers and leaves no partial writes', () => {
    const t = withState((m, tt) => {
      const anyM = m as MemoryAccessor<any>;
      tt.manager.end(tt.plat.state.tick); // 先提交初始化，之后检查预检失败不标脏
      tt.plat.state.tick++;
      tt.manager.begin(tt.plat.state.tick);
      const snapshot = JSON.stringify(m.query());
      const failures: [(string | number)[], unknown, RegExp][] = [
        [['nested', 'missing', 'value'], 1, /missing intermediate/],
        [['count', 'x'], 1, /cannot traverse number/],
        [['list', 3], 4, /out of range/],
        [['list', 'length'], 0, /numeric index/],
        [['tags', 'W1N1'], undefined, /undefined is not a JSON value/],
        [['tags', 'W2N2'], { level: NaN }, /non-finite/],
        [['nested', 'deep'], m.query(), /ancestor/],
        [['tags', 'W2N2'], { back: m.query().tags }, /ancestor/],
      ];
      for (const [path, value, error] of failures)
        expect(() => anyM.commit(path as [string], value)).toThrow(error);
      expect(JSON.stringify(m.query())).toBe(snapshot);
      expect(tt.manager.getStatus().dirty).toEqual([]);

      m.commit(['tags', 'W2N2'], { level: 2 });
      m.commit(['tags', 'W1N1', 'note'], 'dotted.name ok');
      m.commit(['list', 0], 9);
      m.commit('nested', { deep: { value: 5 } });
      const shared = { v: 1 };
      anyM.commit(['tags', 'W3N3'], { level: 3, a: shared, b: shared });
      expect(tt.manager.getStatus().dirty).toHaveLength(1);
    });
    const payload = partitionOf(t.plat, 'o', 'main').payload;
    expect(payload.tags.W2N2).toEqual({ level: 2 });
    expect(payload.tags.W1N1.note).toBe('dotted.name ok');
    expect(payload.list).toEqual([9, 2, 3]);
    expect(payload.nested.deep.value).toBe(5);
  });

  it('removes object properties only and reports whether anything was removed', () => {
    const t = withState((m, tt) => {
      const anyM = m as MemoryAccessor<any>;
      tt.manager.end(tt.plat.state.tick);
      tt.plat.state.tick++;
      tt.manager.begin(tt.plat.state.tick);
      expect(anyM.remove(['tags', 'W9N9'])).toBe(false);
      expect(anyM.remove(['missing', 'x'])).toBe(false);
      expect(tt.manager.getStatus().dirty).toEqual([]);
      expect(() => anyM.remove(['list', 0])).toThrow(/cannot be removed by path/);
      expect(() => anyM.remove(['count', 'x'])).toThrow(/cannot traverse/);
      expect(anyM.remove(['tags', 'W1N1'])).toBe(true);
      expect(anyM.remove('nested')).toBe(true);
      expect(tt.manager.getStatus().dirty).toHaveLength(1);
    });
    const payload = partitionOf(t.plat, 'o', 'main').payload;
    expect(payload.tags).toEqual({});
    expect('nested' in payload).toBe(false);
  });

  it('applies callback semantics: always dirty, no rollback, synchronous and non-reentrant', () => {
    const t = setup();
    let a!: MemoryAccessor<Counter>;
    let b!: MemoryAccessor<Counter>;
    t.tick(() => {
      a = t.bind('o')('a', counterOptions);
      b = t.bind('o')('b', counterOptions);
    });
    t.tick(() => {
      expect(a.commit(() => 'noop')).toBe('noop');
      expect(t.manager.getStatus().dirty).toEqual([{ owner: 'o', localId: 'a' }]);
    });
    t.tick(() => {
      expect(() =>
        a.commit((memory) => {
          memory.count = 42;
          throw new Error('late failure');
        })
      ).toThrow(/late failure/);
      expect(() => a.commit(async () => undefined)).toThrow(/synchronous/);
      a.commit(() => {
        expect(() => a.commit('count', 1)).toThrow(/being modified/);
        expect(() => a.commit(() => undefined)).toThrow(/being modified/);
        b.commit('count', 7); // 其他分区可以修改
        expect(() => t.manager.end(t.plat.state.tick)).toThrow(/reentrantly/);
        expect(() => t.manager.begin(t.plat.state.tick)).toThrow(/reentrantly/);
      });
    });
    expect(partitionOf(t.plat, 'o', 'a').payload.count).toBe(42);
    expect(partitionOf(t.plat, 'o', 'b').payload.count).toBe(7);
  });

  it('rejects modifications after end but keeps reads available', () => {
    const t = setup();
    let a!: MemoryAccessor<Counter>;
    t.tick(() => {
      a = t.bind('o')('a', counterOptions);
    });
    expect(a.get('count')).toBe(0);
    expect(() => a.commit('count', 1)).toThrow(/between begin and end/);
    expect(() => a.remove('count' as never)).toThrow(/between begin and end/);
  });
});

describe('MemoryManager commit-time validation', () => {
  const twoPartitions = () => {
    const t = setup();
    let a!: MemoryAccessor<any>;
    let b!: MemoryAccessor<Counter>;
    t.tick(() => {
      a = t.bind('o')('a', { version: 1, initialize: () => ({ v: 0, box: { n: 1 } }) });
      b = t.bind('o')('b', counterOptions);
    });
    return { t, a, b };
  };

  it('skips full validation for path-only partitions', () => {
    const { t, a } = twoPartitions();
    t.tick(() => {
      a.commit('v', 1);
      // 协议违规：通过别名写入 NaN。未经回调修改的分区不做完整校验，原生 stringify 转成 null。
      (a.query() as any).box.n = NaN;
    });
    expect(partitionOf(t.plat, 'o', 'a').payload).toEqual({ v: 1, box: { n: null } });
  });

  it('blocks every partition when a callback-modified partition is invalid, then recovers', () => {
    const { t, a, b } = twoPartitions();
    const committed = t.plat.state.raw;
    t.tick(() => {
      a.commit((memory) => {
        memory.box.n = NaN;
      });
      a.commit('v', 3); // 回调后的路径写入不清除完整校验标记
      b.commit('count', 9);
    });
    expect(t.plat.state.raw).toBe(committed);
    const failure = t.manager.getStatus().writeFailure!;
    expect(failure).toMatchObject({ stage: 'validate', owner: 'o', localId: 'a' });
    expect(failure.message).toMatch(/\$\.box\.n: non-finite/);

    t.tick(() => a.commit(['box', 'n'], 2));
    expect(partitionOf(t.plat, 'o', 'a').payload).toEqual({ v: 3, box: { n: 2 } });
    expect(partitionOf(t.plat, 'o', 'b').payload.count).toBe(9);
  });

  it('keeps the validation flag across platform failures and clears it after success', () => {
    const { t, a } = twoPartitions();
    t.plat.state.failWrite = new Error('busy');
    t.tick(() => a.commit((memory) => void (memory.v = 1)));
    t.plat.state.failWrite = null;
    t.tick(() => {
      (a.query() as any).box.n = undefined; // 别名写入：标记仍在，收尾应拒绝
    });
    expect(t.manager.getStatus().writeFailure).toMatchObject({ stage: 'validate' });
    t.tick(() => a.commit(['box', 'n'], 1));
    expect(t.manager.getStatus().writeFailure).toBeNull();
    // 成功后标记清除：之后的别名 NaN 在仅路径写入时不再被完整校验。
    t.tick(() => {
      a.commit('v', 5);
      (a.query() as any).box.n = NaN;
    });
    expect(partitionOf(t.plat, 'o', 'a').payload.box.n).toBeNull();
  });

  it('lets stringify reject cycles created in callbacks and terminates on shared objects', () => {
    const { t, a } = twoPartitions();
    t.tick(() =>
      a.commit((memory) => {
        const shared = { s: 1 };
        memory.x = shared;
        memory.y = shared;
        memory.box.self = memory.box;
      })
    );
    expect(t.manager.getStatus().writeFailure).toMatchObject({
      stage: 'encode',
      owner: 'o',
      localId: 'a',
    });
    t.tick(() => a.commit((memory) => void delete memory.box.self));
    expect(partitionOf(t.plat, 'o', 'a').payload.y).toEqual({ s: 1 });
  });
});

describe('MemoryManager loading and compatibility', () => {
  it('locks load failures, never writes and reports them on every begin', () => {
    for (const [raw, error] of [
      ['{bad json', /JSON/],
      ['[1]', /not an object/],
      [JSON.stringify({ memoryManager: { schemaVersion: 99 } }), /Unsupported MemoryManager schema: 99/],
      [JSON.stringify({ memoryManager: { schemaVersion: 2, partitions: { a: { b: { payload: 1 } } } } }), /dataVersion/],
      [JSON.stringify({ memoryManager: { schemaVersion: 2, partitions: {}, extra: 1 } }), /Unknown MemoryManager namespace field/],
    ] as const) {
      const t = setup(raw);
      expect(() => t.begin()).toThrow(error);
      expect(() => t.bind('a')('main', counterOptions)).toThrow(/storage load failed/);
      t.end();
      t.plat.state.tick++;
      expect(() => t.begin()).toThrow(error);
      t.end();
      expect(t.plat.state.reads).toBe(1);
      expect(t.plat.state.writes).toBe(0);
      expect(t.plat.state.raw).toBe(raw);
      expect(t.manager.getStatus().loadError).toMatch(error);
      expect(t.logs.lines.filter((line) => line.includes('storage load failed'))).toHaveLength(1);
    }
  });

  it('does not write for an empty store without applications', () => {
    const t = setup('');
    t.tick();
    t.tick();
    expect(t.plat.state.writes).toBe(0);
  });

  it('preserves historical payloads of any JSON shape and dataVersion 0 across reloads', () => {
    const history = {
      memoryManager: {
        schemaVersion: 2,
        partitions: {
          a: {
            arr: { dataVersion: 1, payload: [1, 2] },
            nul: { dataVersion: 3, payload: null },
            num: { dataVersion: 1, payload: 5 },
            zero: { dataVersion: 0, payload: { legacy: true } },
          },
        },
      },
      external: { keep: [1, 2, 3] },
    };
    const t = setup(JSON.stringify(history));
    t.tick(() => t.bind('b')('main', counterOptions));
    const first = stored(t.plat);
    expect(first.memoryManager.partitions.a).toEqual(history.memoryManager.partitions.a);
    expect(first.external).toEqual(history.external);

    const { manager } = reset(t.plat);
    t.plat.state.tick++;
    manager.begin(t.plat.state.tick);
    const upgraded = manager.bind('a')('zero', {
      version: 1,
      initialize: counterInit,
      migrate: (memory) => ({ count: (memory as { legacy: boolean }).legacy ? 1 : 0 }),
    });
    expect(upgraded.query()).toEqual({ count: 1 });
    manager.end(t.plat.state.tick);
    expect(partitionOf(t.plat, 'a', 'zero')).toEqual({ dataVersion: 1, payload: { count: 1 } });
  });

  it('converts schemaVersion 1, ignoring segment identities and orphan records', () => {
    const v1 = {
      memoryManager: {
        schemaVersion: 1,
        generationCounter: 7,
        allocations: {
          a: { main: { backend: 'raw', generation: 2 }, seg: { backend: 'segment', segmentId: 3, generation: 4 } },
        },
        rawPartitions: {
          a: {
            main: { dataVersion: 1, payload: { count: 4 } },
            seg: { dataVersion: 1, payload: { count: 99 } },
            orphan: { dataVersion: 1, payload: { count: 5 } },
          },
        },
        migration: { generation: 7, phase: 'copy', reason: 'allocation', moves: [], staged: {} },
      },
    };
    const t = setup(JSON.stringify(v1));
    t.tick(); // 没有业务修改，格式转换也要写出
    expect(stored(t.plat).memoryManager).toEqual({
      schemaVersion: 2,
      partitions: { a: { main: { dataVersion: 1, payload: { count: 4 } } } },
    });
    expect(t.manager.getStatus().ignoredSegmentPartitions).toEqual([{ owner: 'a', localId: 'seg' }]);
    expect(t.logs.lines.filter((line) => line.includes('ignored segment partitions: a/seg'))).toHaveLength(1);

    const { manager } = reset(t.plat);
    manager.begin(t.plat.state.tick);
    const initialize = jest.fn(counterInit);
    expect(manager.bind('a')('seg', { version: 1, initialize }).query()).toEqual({ count: 0 });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(manager.bind('a')('main', counterOptions).query()).toEqual({ count: 4 });
  });

  it('repeats the conversion when its write fails', () => {
    const v1 = JSON.stringify({
      memoryManager: {
        schemaVersion: 1,
        allocations: { a: { main: { backend: 'raw', generation: 0 } } },
        rawPartitions: { a: { main: { dataVersion: 1, payload: { count: 1 } } } },
      },
    });
    const t = setup(v1);
    t.plat.state.failWrite = new Error('nope');
    t.tick();
    expect(t.plat.state.raw).toBe(v1);
    t.plat.state.failWrite = null;
    const { manager } = reset(t.plat); // global reset 后重新转换
    manager.begin(t.plat.state.tick);
    manager.end(t.plat.state.tick);
    expect(stored(t.plat).memoryManager.schemaVersion).toBe(2);
  });

  it('reports schemaVersion 1 raw allocations without records as load errors', () => {
    const t = setup(
      JSON.stringify({
        memoryManager: {
          schemaVersion: 1,
          allocations: { a: { main: { backend: 'raw', generation: 0 } } },
          rawPartitions: {},
        },
      })
    );
    expect(() => t.begin()).toThrow(/Missing raw partition/);
  });

  it('imports the legacy leviathan layout without sharing objects with the preserved field', () => {
    const legacy = {
      plugins: { probe: { value: 42 }, versioned: { n: 1 }, notObject: 5 },
      framework: { pluginVersions: { versioned: 3 } },
    };
    const t = setup(JSON.stringify({ leviathan: legacy, other: 'x' }));
    t.tick(() => {
      expect(() => t.bind('probe')('main', { version: 1, initialize: () => ({}) })).toThrow(
        /missing migrate for stored dataVersion 0/
      );
      const versioned = t.bind('versioned')('main', { version: 3, initialize: () => ({ n: 0 }) });
      versioned.commit('n', 2);
    });
    const root = stored(t.plat);
    expect(root.leviathan).toEqual(legacy);
    expect(root.other).toBe('x');
    expect(root.memoryManager.partitions.probe.main).toEqual({ dataVersion: 0, payload: { value: 42 } });
    expect(root.memoryManager.partitions.versioned.main).toEqual({ dataVersion: 3, payload: { n: 2 } });
    expect(root.memoryManager.partitions.notObject).toBeUndefined();
  });
});

describe('MemoryManager lifecycle', () => {
  it('validates ticks, rejects end without begin and does not reopen a finished tick', () => {
    const t = setup();
    expect(() => t.manager.begin(2)).toThrow(/does not match current tick 1/);
    expect(() => t.manager.end(1)).toThrow(/without begin/);
    t.begin();
    const a = t.bind('o')('a', counterOptions);
    t.end();
    const writes = t.plat.state.writes;
    t.manager.end(1); // 重复 end 不重复提交
    t.manager.begin(1); // 同 tick 重复 begin 不重开写入阶段
    expect(() => a.commit('count', 1)).toThrow(/between begin and end/);
    expect(t.plat.state.writes).toBe(writes);
    t.plat.state.tick = 3;
    t.begin(3);
    t.end();
    t.plat.state.tick = 2;
    expect(() => t.manager.begin(2)).toThrow(/older/);
  });

  it('recovers a missed end on the next real tick and keeps dirty data', () => {
    const t = setup();
    let a!: MemoryAccessor<Counter>;
    t.begin();
    a = t.bind('o')('a', counterOptions);
    a.commit('count', 1);
    // 没有 end：下一个真实 tick 的 begin 终结旧阶段。
    t.plat.state.tick = 2;
    t.begin(2);
    a.commit('count', 2);
    t.end();
    expect(partitionOf(t.plat, 'o', 'a').payload.count).toBe(2);
  });

  it('recovers from a hard termination inside a commit callback', () => {
    const t = setup();
    let a!: MemoryAccessor<Counter>;
    t.tick(() => {
      a = t.bind('o')('a', counterOptions);
    });
    t.begin();
    expect(() =>
      runInNewContext('run()', {
        run: () =>
          a.commit((memory) => {
            memory.count = 5;
            for (;;);
          }),
      }, { timeout: 50 })
    ).toThrow(/timed out/);
    // 同一 tick 内锁仍在（回调的 finally 没有执行），同步重入仍被拒绝。
    expect(() => a.commit('count', 1)).toThrow(/being modified/);
    t.plat.state.tick++;
    t.begin();
    a.commit((memory) => void (memory.count += 1));
    t.end();
    expect(partitionOf(t.plat, 'o', 'a').payload.count).toBe(6);
  });

  it('retries a commit interrupted inside the platform write or the baseline update', () => {
    const t = setup();
    let a!: MemoryAccessor<Counter>;
    t.tick(() => {
      a = t.bind('o')('a', counterOptions);
    });
    // 中断发生在平台接受文本之前。
    t.plat.state.onWrite = () => {
      for (;;);
    };
    t.begin();
    a.commit('count', 1);
    expect(() =>
      runInNewContext('run()', { run: () => t.end() }, { timeout: 50 })
    ).toThrow(/timed out/);
    t.plat.state.onWrite = null;
    expect(t.manager.getStatus().dirty).toHaveLength(1);
    t.plat.state.tick++;
    t.tick();
    expect(partitionOf(t.plat, 'o', 'a').payload.count).toBe(1);
    expect(t.manager.getStatus().dirty).toEqual([]);
  });

  it('does not publish an application interrupted during initialize', () => {
    const t = setup();
    t.begin();
    let hang = true;
    const initialize = () => {
      if (hang) for (;;);
      return { count: 1 };
    };
    expect(() =>
      runInNewContext('run()', {
        run: () => t.bind('o')('a', { version: 1, initialize }),
      }, { timeout: 50 })
    ).toThrow(/timed out/);
    expect(t.manager.getStatus().partitions).toEqual([]);
    hang = false;
    t.plat.state.tick++;
    t.begin();
    expect(t.bind('o')('a', { version: 1, initialize }).query()).toEqual({ count: 1 });
    t.end();
  });
});

/** 类型层面的使用示例也要能在运行时工作：const 路径常量复用。 */
describe('MemoryManager path constants', () => {
  it('accepts reusable readonly path constants', () => {
    const t = setup();
    t.tick(() => {
      const m = t.bind('o')('main', {
        version: 1,
        initialize: () => ({ rooms: { W1N1: { level: 1 } } as Record<string, { level: number }> }),
      });
      const path = ['rooms', 'W1N1', 'level'] as const;
      m.commit(path, 2);
      expect(m.get(path)).toBe(2);
    });
  });
});

export type { MemoryManager };
