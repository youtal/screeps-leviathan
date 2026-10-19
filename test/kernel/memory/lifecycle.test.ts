/** 跨 tick、平台拒绝、reset、序列化计数与实体维护集成验证；不替代真实私服。 */
import type { Accessor } from '@/contracts/memory';
import { MEMORY_LIMIT, PlatformError } from '../../platform/memory';
import { harness, marker, spec, type Data } from './harness';

test('每 global 解析一次；干净 tick 零写入；只编码脏单元；reset 首次全量编码', () => {
  const h = harness();
  const parse = jest.spyOn(JSON, 'parse');
  const stringify = jest.spyOn(JSON, 'stringify');
  let a: Accessor<Data>;
  h.tick(1, () => {
    h.memory.initialize(marker);
    a = h.memory.partitions('o').partition('a', spec);
    h.memory.partitions('o').partition('b', spec);
    h.memory.commit();
  });
  expect(parse).toHaveBeenCalledTimes(0); // 空文本无需 JSON.parse。
  const encoded = () => stringify.mock.calls.filter(([value]) => value && typeof value === 'object' && 'version' in value);
  expect(encoded()).toHaveLength(2);
  stringify.mockClear();
  h.tick(2, () => expect(h.memory.commit()).toBe(false));
  expect(h.write).toHaveBeenCalledTimes(1);
  expect(encoded()).toHaveLength(0);
  h.tick(3, () => { a.set(['n'], 7); h.memory.commit(); });
  expect(encoded()).toHaveLength(1);
  expect(h.memory.sizes().total).toBe(h.platform.memory.length);
  expect(h.memory.sizes()).toBe(h.memory.sizes());
  h.reset(); stringify.mockClear();
  expect(() => a.root()).toThrow();
  h.tick(4, () => {
    expect(h.memory.partitions('o').partition('a', spec).get(['n'])).toBe(7);
    h.memory.commit();
  });
  expect(parse).toHaveBeenCalledTimes(1);
  expect(encoded()).toHaveLength(2);
  h.tick(5, () => h.memory.commit());
  expect(parse).toHaveBeenCalledTimes(1);
  parse.mockRestore(); stringify.mockRestore();
});

test('写入抛错保留脏状态与旧尺寸，下一 tick 重试', () => {
  const h = harness();
  h.write.mockImplementationOnce(() => { throw Error('写入中断'); });
  expect(() => h.tick(1, () => {
    h.memory.initialize(marker);
    h.memory.partitions('o').partition('a', spec).set(['n'], 8);
    h.memory.commit();
  })).toThrow('写入中断');
  expect(h.platform.memory).toBe('');
  expect(h.memory.sizes().total).toBe(0);
  h.tick(2, () => expect(h.memory.commit()).toBe(true));
  expect(JSON.parse(h.platform.memory).leviathan.part.o.a.data.n).toBe(8);
});

test('驱动收尾拒绝整个 tick 后重写；提交后的用户异常仍保存', () => {
  const h = harness();
  expect(() => h.tick(1, () => {
    h.memory.initialize(marker);
    h.memory.partitions('o').partition('a', spec).set(['n'], 12);
    h.memory.commit();
    h.target.RawMemory.segments[100] = '拒绝该 tick';
  })).toThrow(PlatformError);
  expect(h.platform.memory).toBe('');
  expect(() => h.tick(2, () => { expect(h.memory.commit()).toBe(true); throw Error('业务异常'); })).toThrow('业务异常');
  expect(JSON.parse(h.platform.memory).leviathan.part.o.a.data.n).toBe(12);
  h.tick(3, () => expect(h.memory.commit()).toBe(false));
});

test.each(['{', '{"leviathan":{"sys":{"schema":99}}}'])('拒绝损坏文本或不符的同名命名空间 %s', (text) => {
  const h = harness(text);
  expect(() => h.tick(1, () => h.memory.initialize(marker))).toThrow();
  expect(() => h.memory.commit()).toThrow();
  expect(h.write).not.toHaveBeenCalled();
  expect(h.platform.memory).toBe(text);
});

test('晚接管拒绝；临时 Memory 不会覆盖真实存储', () => {
  const h = harness();
  const result = h.platform.tick(() => {
    void h.target.Memory;
    h.memory.beginTick({ time: 1, creeps: new Set(), flags: new Set() });
  });
  expect(result.error).toBeInstanceOf(Error);
  h.tick(2, () => {
    h.memory.initialize(marker);
    h.target.Memory = { foreign: '临时修改' };
    h.memory.commit();
  });
  expect(JSON.parse(h.platform.memory).foreign).toBeUndefined();
});

test('开发抽查发现未标脏修改；非法 update 数据被隔离不落盘，且可以修复', () => {
  const h = harness('', 1);
  let a: Accessor<Data>;
  h.tick(1, () => { h.memory.initialize(marker); a = h.memory.partitions('o').partition('a', spec); h.memory.commit(); });
  expect(() => h.tick(2, () => { (a.root() as Data).n = 99; h.memory.commit(); })).toThrow('未标脏');
  h.tick(3, () => { a.update(['list'], (list) => list.push(NaN)); expect(h.memory.commit()).toBe(false); });
  expect(JSON.parse(h.platform.memory).leviathan.part.o.a.data.list).toEqual([1, 2]);
  h.tick(4, () => { a.replace(spec.initialize()); h.memory.commit(); });
  expect(JSON.parse(h.platform.memory).leviathan.part.o.a.data.n).toBe(0);
});

test('尺寸硬限制与告警异常不丢失脏数据', () => {
  const h = harness();
  h.warn.mockImplementation(() => { throw Error('日志不可用'); });
  let a: Accessor<Data>;
  expect(() => h.tick(1, () => {
    h.memory.initialize(marker); a = h.memory.partitions('o').partition('a', spec);
    a.set(['nested', 'value'], 'x'.repeat(MEMORY_LIMIT)); h.memory.commit();
  })).toThrow('超过');
  expect(h.write).not.toHaveBeenCalled();
  h.tick(2, () => { a.set(['nested', 'value'], 'x'.repeat(Math.ceil(1.8 * 1024 * 1024))); h.memory.commit(); });
  expect(h.warn).toHaveBeenCalledTimes(2);
  expect(h.platform.memory.length).toBe(h.memory.sizes().total);
});

test('creep 连续缺席回收及旧访问器失效；跳 tick 重新积累证据', () => {
  const h = harness();
  let a: Accessor<Data>;
  h.tick(1, () => {
    h.memory.initialize(marker);
    a = h.memory.entities('o').creeps.slice(spec).of('c');
    h.memory.maintain(); h.memory.commit();
  }, { creeps: new Set(['c']) });
  h.tick(2, () => { h.memory.maintain(); expect(a.root()).toBeDefined(); });
  h.tick(4, () => { h.memory.maintain(); expect(a.root()).toBeDefined(); });
  h.tick(5, () => {
    h.memory.maintain(); expect(() => a.root()).toThrow('失效');
    const slices = h.memory.entities('o').creeps.slice(spec);
    expect(slices.has('c')).toBe(false);
    expect(slices.of('c')).not.toBe(a);
    h.memory.commit();
  });
});

test('维护预算跨调用累计；flag 回收、房间保护与过期边界', () => {
  const h = harness();
  h.tick(20001, () => {
    h.memory.initialize(marker);
    const e = h.memory.entities('o');
    for (const name of ['own', 'protected', 'unknown', 'boundary', 'expired']) e.rooms.slice(spec).of(name);
    e.flags.slice(spec).of('gone');
    expect(h.memory.maintain(3)).toBe(3);
    expect(h.memory.maintain(3)).toBe(0);
    expect(h.memory.maintain(6)).toBe(3);
    expect(e.rooms.slice(spec).has('expired')).toBe(false);
    // 本 tick 新建的 flag 记录受保护：名称快照看不到快照之后才创建的 flag（MA-01）。
    expect(e.flags.slice(spec).has('gone')).toBe(true);
    for (const name of ['own', 'protected', 'unknown', 'boundary']) expect(e.rooms.slice(spec).has(name)).toBe(true);
    expect(() => h.memory.entities('core')).toThrow();
    h.memory.commit();
  }, { rooms: {
    own: { owned: true, protected: false, lastSeen: 0 },
    protected: { owned: false, protected: true, lastSeen: 0 },
    boundary: { owned: false, protected: false, lastSeen: 1 },
    expired: { owned: false, protected: false, lastSeen: 0 },
  } });
  // 下一 tick 记录已存在 1 tick，flag 仍不在事实中即回收。
  h.tick(20002, () => {
    h.memory.maintain();
    expect(h.memory.entities('o').flags.slice(spec).has('gone')).toBe(false);
    h.memory.commit();
  });
});

test('维护惰性迁移已声明切片，保留未声明 owner 和命名空间外数据', () => {
  const h = harness();
  h.tick(1, () => {
    h.memory.initialize(marker);
    h.memory.entities('o').rooms.slice(spec).of('toString');
    h.memory.entities('unknown').rooms.slice(spec).of('toString');
    h.memory.commit();
  });
  const root = JSON.parse(h.platform.memory); root.peer = { preserved: true };
  const restored = harness(JSON.stringify(root));
  restored.tick(2, () => {
    restored.memory.entities('o').rooms.slice({ ...spec, version: 2, migrate: () => ({ ...spec.initialize(), n: 2 }) });
    restored.memory.maintain(); restored.memory.commit();
  });
  const saved = JSON.parse(restored.platform.memory);
  expect(saved.peer).toEqual(root.peer);
  expect(saved.leviathan.rooms.toString.o.version).toBe(2);
  expect(saved.leviathan.rooms.toString.unknown).toEqual(root.leviathan.rooms.toString.unknown);
  expect(restored.platform.memory).toBe(JSON.stringify(saved));
});

test('确定性写入序列与全量 JSON 编码完全等价', () => {
  const h = harness();
  let a: Accessor<Data>;
  const expected = { leviathan: { sys: marker, part: { o: { a: { version: 1, data: spec.initialize() } } }, rooms: {}, creeps: {}, flags: {} } };
  let seed = 17;
  for (let time = 1; time <= 60; time += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    h.tick(time, () => {
      if (time === 1) { h.memory.initialize(marker); a = h.memory.partitions('o').partition('a', spec); }
      const value = `${seed}中文\n\"\\`;
      a.set(['nested', 'value'], value); expected.leviathan.part.o.a.data.nested.value = value;
      a.set(['n'], seed); expected.leviathan.part.o.a.data.n = seed;
      h.memory.commit();
    });
    expect(h.platform.memory).toBe(JSON.stringify(expected));
  }
});
