/**
 * 文件摘要：Memory v1 交付审计（docs/audit/2026-10-19-memory-delivery.md）整改项的回归测试。
 * MA-01：本 tick 新建的实体记录不被维护扫描回收，创建 tick 属于整条记录，加载记录不受新建保护。
 * MA-03：缺少本项目命名空间的合法根返回 empty，其他根键只读保留，初始化后与命名空间并存。
 * MA-05：只校验 update 修改过的单元；待校验标记跨失败提交保持，set 不能清除，replace 可以清除。
 */
import { harness, marker, spec } from './harness';

const persisted = (h: ReturnType<typeof harness>) => JSON.parse(h.platform.memory) as Record<string, any>;

describe('MA-01 新建实体记录的回收保护', () => {
  test('孵化当 tick 写入 creep 切片并维护，记录保留；creep 下一 tick 出现', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.commit(); });
    h.tick(2, () => {
      h.memory.entities('spawnQueue').creeps.slice(spec).of('newborn').set(['n'], 1);
      expect(h.memory.maintain()).toBe(1);
      h.memory.commit();
    });
    h.tick(3, () => {
      expect(h.memory.entities('spawnQueue').creeps.slice(spec).has('newborn')).toBe(true);
    }, { creeps: new Set(['newborn']) });
    expect(Object.keys(persisted(h).leviathan.creeps)).toEqual(['newborn']);
  });

  test('从未出现的 creep 记录在创建满 2 tick 且相邻两 tick 缺席后回收', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.commit(); });
    h.tick(2, () => { h.memory.entities('m').creeps.slice(spec).of('ghost'); h.memory.maintain(); h.memory.commit(); });
    h.tick(3, () => { h.memory.maintain(); expect(h.memory.entities('m').creeps.slice(spec).has('ghost')).toBe(true); });
    h.tick(4, () => { h.memory.maintain(); expect(h.memory.entities('m').creeps.slice(spec).has('ghost')).toBe(false); });
  });

  test('createFlag 当 tick 写入的 flag 记录保留，下一 tick flag 仍缺席时回收', () => {
    const h = harness();
    h.tick(1, () => {
      h.memory.initialize(marker);
      h.memory.entities('planner').flags.slice(spec).of('Flag1').set(['n'], 1);
      h.memory.maintain();
      h.memory.commit();
    });
    expect(Object.keys(persisted(h).leviathan.flags)).toEqual(['Flag1']);
    h.tick(2, () => { h.memory.maintain(); h.memory.commit(); });
    expect(persisted(h).leviathan.flags).toEqual({});
  });

  test('为已有记录增加其他 owner 的切片不刷新创建 tick', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.entities('a').creeps.slice(spec).of('old'); h.memory.commit(); });
    h.tick(2, () => { h.memory.entities('b').creeps.slice(spec).of('old'); h.memory.commit(); });
    h.tick(3, () => { h.memory.maintain(); h.memory.commit(); });
    expect(persisted(h).leviathan.creeps).toEqual({});
  });

  test('加载得到的记录不受新建保护：reset 后相邻两 tick 缺席即回收', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.entities('m').creeps.slice(spec).of('dead'); h.memory.commit(); },
      { creeps: new Set(['dead']) });
    h.reset();
    h.tick(10, () => { h.memory.maintain(); h.memory.commit(); });
    expect(Object.keys(persisted(h).leviathan.creeps)).toEqual(['dead']);
    h.tick(11, () => { h.memory.maintain(); h.memory.commit(); });
    expect(persisted(h).leviathan.creeps).toEqual({});
  });

  test('同名记录被回收后重建，得到新的创建 tick 与新访问器', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.entities('m').flags.slice(spec).of('F'); h.memory.commit(); });
    let old: ReturnType<ReturnType<typeof h.memory.entities>['flags']['slice']> | undefined;
    h.tick(2, () => { old = h.memory.entities('m').flags.slice(spec); h.memory.maintain(); h.memory.commit(); });
    h.tick(3, () => {
      const accessor = old!.of('F');
      accessor.set(['n'], 3);
      h.memory.maintain();
      expect(old!.has('F')).toBe(true);
      h.memory.commit();
    });
    expect(persisted(h).leviathan.flags.F.m.data.n).toBe(3);
  });

  test('已有 60 条记录时，新记录在同一轮扫描中被访问但不被回收', () => {
    const h = harness();
    const names = Array.from({ length: 60 }, (_, i) => `c${i}`);
    h.tick(1, () => {
      h.memory.initialize(marker);
      const s = h.memory.entities('m').creeps.slice(spec);
      for (const n of names) s.of(n);
      h.memory.commit();
    }, { creeps: new Set(names) });
    h.tick(2, () => { h.memory.maintain(40); h.memory.commit(); }, { creeps: new Set(names) });
    h.tick(3, () => {
      h.memory.entities('m').creeps.slice(spec).of('late');
      // 游标从 c40 继续，late 排在第 21 个，随后回绕扫满上限；late 被访问但不被回收。
      expect(h.memory.maintain(40)).toBe(40);
      h.memory.commit();
    }, { creeps: new Set(names) });
    expect(Object.keys(persisted(h).leviathan.creeps)).toContain('late');
  });
});

describe('MA-03 缺少本项目命名空间的合法根', () => {
  test.each([
    ['引擎默认空对象形状', '{"creeps":{},"spawns":{},"rooms":{},"flags":{},"powerCreeps":{}}'],
    ['外来根键', '{"foreignBot":{"x":1}}'],
  ])('%s：返回 empty，初始化后其他根键原样保留在前', (_label, text) => {
    const h = harness(text);
    let state = '';
    h.tick(1, () => {
      state = h.memory.beginTick({ time: 1, creeps: new Set(), flags: new Set() });
      h.memory.initialize(marker);
      h.memory.commit();
    });
    expect(state).toBe('empty');
    const before = JSON.parse(text) as Record<string, unknown>;
    const root = persisted(h);
    expect(Object.keys(root)).toEqual([...Object.keys(before), 'leviathan']);
    for (const key of Object.keys(before)) expect(root[key]).toEqual(before[key]);
    h.reset();
    h.tick(2, () => { expect(h.memory.beginTick({ time: 2, creeps: new Set(), flags: new Set() })).toBe('ready'); h.memory.commit(); });
    expect(Object.keys(persisted(h))).toEqual([...Object.keys(before), 'leviathan']);
  });

  test('未经初始化不写入，外来文本保持不变', () => {
    const text = '{"foreignBot":{"x":1}}';
    const h = harness(text);
    h.tick(1, () => { expect(() => h.memory.commit()).toThrow('尚未加载或初始化'); });
    h.tick(2, () => undefined);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.platform.memory).toBe(text);
  });

  test.each(['[]', '5', '{"leviathan":{"x":1}}'])('非对象根或不符的同名命名空间仍拒绝且不可初始化 %s', (text) => {
    const h = harness(text);
    expect(() => h.tick(1, () => undefined)).toThrow();
    expect(() => h.memory.initialize(marker)).toThrow();
    expect(h.platform.memory).toBe(text);
  });

  test('命名空间已初始化后不能再次初始化', () => {
    const h = harness();
    h.tick(1, () => {
      h.memory.initialize(marker);
      expect(() => h.memory.initialize(marker)).toThrow('本项目命名空间已存在');
    });
  });
});

describe('MA-05 只校验 update 修改过的单元', () => {
  const list = Array.from({ length: 1000 }, (_, i) => i);

  test('只经 set 写入的脏单元在 commit 时不再遍历校验', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.partitions('o').partition('a', spec); h.memory.commit(); });
    const descriptor = jest.spyOn(Object, 'getOwnPropertyDescriptor');
    let atCommit = -1;
    h.tick(2, () => {
      h.memory.partitions('o').partition('a', spec).set(['list'], list);
      descriptor.mockClear();
      h.memory.commit();
      atCommit = descriptor.mock.calls.length;
    });
    descriptor.mockRestore();
    expect(atCommit).toBe(0);
    expect(persisted(h).leviathan.part.o.a.data.list).toHaveLength(1000);
  });

  test('update 留下非法值时仍被校验拦下：该单元被隔离，保留上一版文本', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.partitions('o').partition('a', spec); h.memory.commit(); });
    const text = h.platform.memory;
    h.tick(2, () => {
      h.memory.partitions('o').partition('a', spec).update(['list'], (draft) => { (draft as number[]).push(NaN); });
      expect(h.memory.commit()).toBe(false);
    });
    expect(h.platform.memory).toBe(text);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  test('待校验标记跨失败提交保持；set 改写其他字段不能清除，replace 整体替换后可以提交', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.partitions('o').partition('a', spec); h.memory.commit(); });
    h.tick(2, () => {
      h.memory.partitions('o').partition('a', spec).update(['nested'], (draft) => {
        (draft as { value?: string }).value = undefined;
      });
      expect(h.memory.commit()).toBe(false);
    });
    // set 不能清除待校验标记：单元仍被隔离，n=3 不落盘；若被清除，undefined 会被静默省略而写出 n=3。
    h.tick(3, () => {
      h.memory.partitions('o').partition('a', spec).set(['n'], 3);
      expect(h.memory.commit()).toBe(false);
    });
    expect(persisted(h).leviathan.part.o.a.data.n).toBe(0);
    h.tick(4, () => {
      h.memory.partitions('o').partition('a', spec).replace(spec.initialize());
      expect(h.memory.commit()).toBe(true);
    });
    expect(persisted(h).leviathan.part.o.a.data).toEqual(spec.initialize());
  });

  test('reset 后首次提交不重复校验加载时已校验的数据', () => {
    const h = harness();
    h.tick(1, () => {
      h.memory.initialize(marker);
      h.memory.partitions('o').partition('a', spec).set(['list'], list);
      h.memory.commit();
    });
    h.reset();
    const descriptor = jest.spyOn(Object, 'getOwnPropertyDescriptor');
    let atCommit = -1;
    h.tick(2, () => { descriptor.mockClear(); h.memory.commit(); atCommit = descriptor.mock.calls.length; });
    descriptor.mockRestore();
    expect(atCommit).toBe(0);
  });
});

describe('MA-02 单元级隔离', () => {
  const breakNested = (h: ReturnType<typeof harness>, owner: string) =>
    h.memory.partitions(owner).partition('p', spec).update(['nested'], (draft) => {
      (draft as { value?: string }).value = undefined;
    });

  test('A 非法时 B 的合法修改照常写回，A 沿用上一版编码并告警一次', () => {
    const h = harness();
    h.tick(1, () => {
      h.memory.initialize(marker);
      h.memory.partitions('a').partition('p', spec).set(['n'], 1);
      h.memory.partitions('b').partition('p', spec);
      h.memory.commit();
    });
    h.tick(2, () => {
      breakNested(h, 'a');
      h.memory.partitions('a').partition('p', spec).set(['n'], 2);
      h.memory.partitions('b').partition('p', spec).set(['n'], 5);
      expect(h.memory.commit()).toBe(true);
    });
    const part = persisted(h).leviathan.part;
    expect(part.a.p.data).toEqual({ n: 1, nested: { value: '初始' }, list: [1, 2] });
    expect(part.b.p.data.n).toBe(5);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][0]).toContain('["part","a","p"]');
    expect(h.memory.sizes().total).toBe(h.platform.memory.length);
  });

  test('只剩隔离单元待写时不写入，也不重复告警', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.partitions('a').partition('p', spec); h.memory.commit(); });
    h.tick(2, () => { breakNested(h, 'a'); expect(h.memory.commit()).toBe(false); });
    h.tick(3, () => expect(h.memory.commit()).toBe(false));
    h.tick(4, () => expect(h.memory.commit()).toBe(false));
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  test('修复后恢复写回并结束隔离；再次失败会重新告警', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.partitions('a').partition('p', spec); h.memory.commit(); });
    h.tick(2, () => { breakNested(h, 'a'); h.memory.commit(); });
    h.tick(3, () => {
      h.memory.partitions('a').partition('p', spec).update(['nested'], (draft) => { delete (draft as { value?: string }).value; });
      expect(h.memory.commit()).toBe(true);
    });
    expect(persisted(h).leviathan.part.a.p.data.nested).toEqual({});
    h.tick(4, () => { breakNested(h, 'a'); expect(h.memory.commit()).toBe(false); });
    expect(h.warn).toHaveBeenCalledTimes(2);
  });

  test('reset 后首次提交前变为非法：沿用加载时的持久版本，其他单元照常写回', () => {
    const h = harness();
    h.tick(1, () => {
      h.memory.initialize(marker);
      h.memory.partitions('a').partition('p', spec).set(['n'], 7);
      h.memory.partitions('b').partition('p', spec);
      h.memory.commit();
    });
    h.reset();
    h.tick(2, () => {
      breakNested(h, 'a');
      h.memory.partitions('b').partition('p', spec).set(['n'], 9);
      expect(h.memory.commit()).toBe(true);
    });
    const part = persisted(h).leviathan.part;
    expect(part.a.p.data).toEqual({ n: 7, nested: { value: '初始' }, list: [1, 2] });
    expect(part.b.p.data.n).toBe(9);
  });

  test('新建单元当 tick 变为非法：以首次 update 前的合法数据写出，不产生空记录', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.commit(); });
    h.tick(2, () => {
      h.memory.entities('m').creeps.slice(spec).of('c1').update(['nested'], (draft) => {
        (draft as { value?: string }).value = undefined;
      });
      expect(h.memory.commit()).toBe(true);
    }, { creeps: new Set(['c1']) });
    expect(persisted(h).leviathan.creeps.c1.m.data).toEqual(spec.initialize());
  });

  test('隔离单元保持脏状态，开发抽查不把它误报为未标脏修改', () => {
    const h = harness('', 10);
    h.tick(1, () => {
      h.memory.initialize(marker);
      h.memory.partitions('a').partition('p', spec);
      h.memory.partitions('b').partition('p', spec);
      h.memory.commit();
    });
    h.tick(2, () => { breakNested(h, 'a'); h.memory.partitions('b').partition('p', spec).set(['n'], 1); h.memory.commit(); });
    h.tick(3, () => { h.memory.partitions('b').partition('p', spec).set(['n'], 2); expect(h.memory.commit()).toBe(true); });
    expect(persisted(h).leviathan.part.b.p.data.n).toBe(2);
  });

  test('编码基线只在单元尚无基线时由 update 生成：已有基线的 update 不额外编码', () => {
    const h = harness();
    h.tick(1, () => { h.memory.initialize(marker); h.memory.partitions('a').partition('p', spec); h.memory.commit(); });
    const stringify = jest.spyOn(JSON, 'stringify');
    let withBaseline = -1;
    let afterReset = -1;
    h.tick(2, () => {
      const a = h.memory.partitions('a').partition('p', spec);
      stringify.mockClear();
      a.update(['list'], (draft) => { (draft as number[]).push(3); });
      withBaseline = stringify.mock.calls.length;
      h.memory.commit();
    });
    h.reset();
    h.tick(3, () => {
      const a = h.memory.partitions('a').partition('p', spec);
      stringify.mockClear();
      a.update(['list'], (draft) => { (draft as number[]).push(4); });
      afterReset = stringify.mock.calls.length;
      h.memory.commit();
    });
    stringify.mockRestore();
    expect(withBaseline).toBe(0);
    expect(afterReset).toBe(1);
  });
});
