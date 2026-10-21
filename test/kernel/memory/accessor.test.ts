/** 验证公共存储契约，非法输入通过类型断言模拟 JavaScript 调用方。 */
import type { Json } from '@/contracts/memory';
import { copyJson, validateJson } from '@/kernel/memory/json';
import { checkPath } from '@/kernel/memory/path';
import { harness, marker, spec, type Data } from './harness';

test('分区隔离、访问器缓存、输入复制与只读引用', () => {
  const h = harness();
  h.tick(1, () => {
    h.memory.initialize(marker);
    const factory = h.memory.partitions('toString');
    const a = factory.partition('a', spec);
    expect(factory.partition('a', spec)).toBe(a);
    expect(h.memory.partitions('toString')).toBe(factory);
    const input = { value: '副本' };
    a.set(['nested'], input); input.value = '外部修改';
    expect(a.get(['nested', 'value'])).toBe('副本');
    expect(a.get(['nested'])).toBe(a.root().nested);
    expect(h.memory.partitions('other').partition('a', spec).get(['nested', 'value'])).toBe('初始');
    a.replace(spec.initialize());
    expect(a.root()).toEqual(spec.initialize());
    h.memory.commit();
  });
  expect(JSON.parse(h.platform.memory).leviathan.part.toString.a.version).toBe(1);
});

test('路径创建、数组限制、删除以及异常 update 的部分修改', () => {
  const h = harness();
  h.tick(1, () => {
    h.memory.initialize(marker);
    const a = h.memory.partitions('owner').partition('a', spec);
    expect(a.get(['optional', 'value'])).toBeUndefined();
    expect(a.has(['optional'])).toBe(false);
    expect(a.keys(['optional'])).toEqual([]);
    expect(() => a.set(['optional', 'value'], 3)).toThrow();
    a.set(['optional', 'value'], 3, { create: true });
    expect(a.get(['optional', 'value'])).toBe(3);
    expect(() => a.set(['list', 2], 3)).toThrow();
    expect(() => a.delete(['list', 0])).toThrow();
    expect(() => a.keys(['n'])).toThrow();
    expect(a.delete(['optional'])).toBe(true);
    expect(a.delete(['optional'])).toBe(false);
    expect(() => a.update(['list'], (draft) => { draft.splice(0, 1); throw Error('业务异常'); })).toThrow('业务异常');
    h.memory.commit();
  });
  expect(JSON.parse(h.platform.memory).leviathan.part.owner.a.data.list).toEqual([2]);
});

test.each([[], Array(9).fill('x'), ['x', '__proto__'], ['constructor'], ['prototype'], [-1], [1.2], [NaN]].map((path) => [path]))(
  '拒绝非法路径 %j', (path) => { expect(() => checkPath(path as (string | number)[])).toThrow(); },
);

test.each([NaN, Infinity, undefined, () => 1, new Date(), [, 1], [undefined], { x: () => 1 }, { [Symbol('x')]: 1 }].map((value) => [value]))(
  '拒绝不可持久化数据 %#', (value) => { expect(() => validateJson(value)).toThrow(); },
);

test('JSON 校验不调用 getter，拒绝循环，复制安全处理原型键', () => {
  const getter = jest.fn(() => 1);
  expect(() => copyJson(Object.defineProperty({}, 'x', { get: getter, enumerable: true }))).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  expect(() => validateJson(cycle)).toThrow();
  const copy = copyJson(JSON.parse('{"__proto__":{"polluted":true},"x":null}'));
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  expect(Object.hasOwn(copy, '__proto__')).toBe(true);
  expect(copyJson({ shared: [1] })).toEqual({ shared: [1] });
});

test.each([
  { optional: undefined }, { nested: { value: undefined } },
  new Map([['x', 1]]), new Set([1]), new Date(), /x/, new Number(1),
  1n, Symbol('value'), new (class { value = 1; })(),
].map((value) => [value]))('拒绝静默转换的数据类型 %#', (value) => {
  expect(() => validateJson(value)).toThrow(TypeError);
  expect(() => copyJson(value)).toThrow(TypeError);
});

test('Map 显式转换后可写入，不调用自定义 toJSON', () => {
  const map = new Map([['x', 1]]);
  expect(copyJson(Object.fromEntries(map))).toEqual({ x: 1 });
  expect(copyJson(Array.from(map))).toEqual([['x', 1]]);
  const toJSON = jest.fn(() => ({ x: 1 }));
  expect(() => copyJson({ toJSON })).toThrow(TypeError);
  expect(toJSON).not.toHaveBeenCalled();
});

test('显式 undefined 写入被拒绝；update 留下非法值时该单元被隔离并保留上一版文本', () => {
  const h = harness();
  h.tick(1, () => {
    h.memory.initialize(marker);
    const a = h.memory.partitions('o').partition('a', spec);
    expect(() => a.set(['optional'], undefined)).toThrow(TypeError);
    expect(() => a.replace({ ...spec.initialize(), optional: undefined })).toThrow(TypeError);
    h.memory.commit();
  });
  const before = h.platform.memory;
  h.tick(2, () => {
    const a = h.memory.partitions('o').partition('a', spec);
    a.update(['nested'], (draft) => { (draft as unknown as { value: undefined }).value = undefined; });
    expect(h.memory.commit()).toBe(false);
  });
  expect(h.platform.memory).toBe(before);
  expect(h.warn).toHaveBeenCalledTimes(1);
  h.tick(3, () => {
    h.memory.partitions('o').partition('a', spec).replace(spec.initialize());
    expect(h.memory.commit()).toBe(true);
  });
});

test('初始化失败无残留；迁移失败保留原始记录并可重试', () => {
  const h = harness();
  h.tick(1, () => {
    h.memory.initialize(marker);
    const factory = h.memory.partitions('o');
    expect(() => factory.partition('bad', { ...spec, initialize: () => NaN as unknown as Data })).toThrow();
    factory.partition('good', spec).set(['n'], 4);
    h.memory.commit();
  });
  h.reset();
  const migrate = jest.fn((old: Json) => { (old as Data).n = 999; throw new Error('迁移失败'); });
  const next = { ...spec, version: 2, migrate };
  h.tick(2, () => {
    expect(() => h.memory.partitions('o').partition('good', next)).toThrow('迁移失败');
    h.memory.commit();
  });
  const stored = JSON.parse(h.platform.memory).leviathan.part.o;
  expect(stored.bad).toBeUndefined();
  expect(stored.good).toEqual({ version: 1, data: { ...spec.initialize(), n: 4 } });
  migrate.mockImplementationOnce((old: Json) => ({ ...(old as Data), n: 5 }) as never);
  h.tick(3, () => {
    expect(h.memory.partitions('o').partition('good', next).get(['n'])).toBe(5);
    h.memory.commit();
  });
  expect(JSON.parse(h.platform.memory).leviathan.part.o.good.version).toBe(2);
});
