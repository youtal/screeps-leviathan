/** MS-01～04 与审计 PA-02：用行为与操作计数验证简化，不以 Node 耗时推断 Screeps CPU 收益。 */
import type { Accessor } from '@/contracts/memory';
import { copyJson, isObject, validateJson } from '@/kernel/memory/json';
import { deleteAt, getAt, hasAt, setAt } from '@/kernel/memory/path';
import { touch, type Unit } from '@/kernel/memory/unit';
import { harness, marker, spec, type Data } from './harness';

test('MS-01：has 区分缺失字段和 update 暂存非法值，删除非法字段后可提交', () => {
  const h = harness();
  h.tick(1, () => {
    h.memory.initialize(marker);
    const a = h.memory.partitions('o').partition('a', spec);
    expect(a.has(['optional'])).toBe(false);
    a.update(['nested'], (draft) => { (draft as { value: string | undefined }).value = undefined; });
    expect(a.get(['nested', 'value'])).toBeUndefined();
    expect(a.has(['nested', 'value'])).toBe(true);
    // 非法单元被隔离（MA-02）：沿用首次 update 前的合法编码写出，非法值不落盘。
    expect(h.memory.commit()).toBe(true);
  });
  expect(JSON.parse(h.platform.memory).leviathan.part.o.a.data.nested).toEqual({ value: '初始' });
  h.tick(2, () => {
    const a = h.memory.partitions('o').partition('a', spec);
    expect(a.delete(['nested', 'value'])).toBe(true);
    expect(a.has(['nested', 'value'])).toBe(false);
    expect(h.memory.commit()).toBe(true);
  });
  expect(JSON.parse(h.platform.memory).leviathan.part.o.a.data.nested).toEqual({});
});

test('MS-02：重复标脏无需修改单元字段，脏队列仍去重', () => {
  const unit: Unit = { id: 'test', owner: 'o', record: { version: 1, data: {} }, head: '"test":', parentHead: '"o":',
    dirty: new Set(), check() {}, active: true, needsValidation: false, isolated: false };
  let writes = 0;
  const observed = new Proxy(unit, { set(target, key, value) { writes += 1; return Reflect.set(target, key, value); } });
  for (let i = 0; i < 10; i += 1) touch(observed);
  expect(writes).toBe(0);
  expect(unit.dirty.size).toBe(1);
  expect(unit.dirty.has(observed)).toBe(true);
});

test('MS-03：多段 has/delete 不创建路径切片，保留读取和删除语义', () => {
  const route = ['nested', 'value'];
  const slice = jest.spyOn(route, 'slice');
  const root = { nested: { value: 1 } };
  expect(getAt(root, route)).toBe(1);
  expect(hasAt(root, route)).toBe(true);
  expect(deleteAt(root, route)).toBe(true);
  expect(hasAt(root, route)).toBe(false);
  expect(deleteAt(root, route)).toBe(false);
  expect(slice).not.toHaveBeenCalled();
  slice.mockRestore();
});

test('MS-03：父路径定位仍拒绝段类型错误，支持单段、数组父节点及缺失路径', () => {
  const root = { rows: [{ value: 1 }], scalar: 1 };
  expect(hasAt(root, ['rows'])).toBe(true);
  expect(hasAt(root, ['missing', 'value'])).toBe(false);
  expect(deleteAt(root, ['scalar', 'value'])).toBe(false);
  expect(() => hasAt(root, ['rows', '0', 'value'])).toThrow(TypeError);
  expect(() => deleteAt(root, ['rows', '0', 'value'])).toThrow(TypeError);
  expect(hasAt(root, ['rows', 0, 'value'])).toBe(true);
  expect(deleteAt(root, ['rows', 0, 'value'])).toBe(true);
  expect(() => deleteAt(root, ['rows', 0])).toThrow(TypeError);
  expect(() => setAt(root, ['rows', '0'], {}, false)).toThrow(TypeError);
  expect(() => setAt(root, ['rows', 1], {}, false)).toThrow(RangeError);
  setAt(root, ['rows', 0], { value: 2 }, false);
  expect(getAt(root, ['rows', 0, 'value'])).toBe(2);
});

test.each(['validate', 'copy'] as const)('MS-04：%s 每个容器只分类及读取原型一次', (mode) => {
  // 四个容器：根对象、数组、普通子对象、无原型字典。
  const input = { rows: [{ value: 1 }], dictionary: Object.assign(Object.create(null) as Record<string, number>, { n: 2 }) };
  const arrays = jest.spyOn(Array, 'isArray');
  const prototypes = jest.spyOn(Object, 'getPrototypeOf');
  let arrayCalls: number;
  let prototypeCalls: number;
  try {
    if (mode === 'copy') copyJson(input); else validateJson(input);
    arrayCalls = arrays.mock.calls.length;
    prototypeCalls = prototypes.mock.calls.length;
  } finally { arrays.mockRestore(); prototypes.mockRestore(); }
  expect(arrayCalls).toBe(4);
  expect(prototypeCalls).toBe(4);
});

test('MS-04：isObject 对无原型字典只读取一次原型', () => {
  const input = Object.create(null);
  const prototypes = jest.spyOn(Object, 'getPrototypeOf');
  let result: boolean;
  let calls: number;
  try { result = isObject(input); calls = prototypes.mock.calls.length; }
  finally { prototypes.mockRestore(); }
  expect(result).toBe(true);
  expect(calls).toBe(1);
  expect(isObject([])).toBe(false);
  expect(isObject(null)).toBe(false);
  expect(isObject(new Date())).toBe(false);
});

test('PA-02：有写入的提交只编码脏单元，键片段复用登记时的转义，JSON.stringify 次数与单元总数无关', () => {
  /**
   * @description 建立 n 个 creep 切片与一个分区并提交，然后只修改一个切片，统计这次提交调用 JSON.stringify 的次数。
   * @param n creep 切片数。
   * @returns 第二次提交的调用次数与提交后的持久文本。
   */
  const count = (n: number): { calls: number; text: string } => {
    const h = harness();
    const names = Array.from({ length: n }, (_, i) => `c${i}`);
    let first: Accessor<Data>;
    h.tick(1, () => {
      h.memory.initialize(marker);
      h.memory.partitions('o').partition('p', spec);
      const slices = h.memory.entities('o').creeps.slice(spec);
      for (const name of names) slices.of(name);
      first = slices.of('c0');
      h.memory.commit();
    }, { creeps: new Set(names) });
    const stringify = jest.spyOn(JSON, 'stringify');
    let calls = 0;
    try {
      h.tick(2, () => { first.set(['n'], 1); h.memory.commit(); calls = stringify.mock.calls.length; }, { creeps: new Set(names) });
    } finally { stringify.mockRestore(); }
    return { calls, text: h.platform.memory };
  };
  const small = count(100);
  const large = count(1000);
  // 1 次编码脏单元，其余为命名空间与根的少数键；修复前为 3n + 7 次。
  expect(small.calls).toBe(large.calls);
  expect(small.calls).toBeLessThanOrEqual(8);
  // 拼接结果与全量编码一致。
  expect(large.text).toBe(JSON.stringify(JSON.parse(large.text)));
  expect(JSON.parse(large.text).leviathan.creeps.c0.o.data.n).toBe(1);
});
