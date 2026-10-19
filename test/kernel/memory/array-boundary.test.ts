/** MD-01 回归：非普通数组必须被拒绝，不能丢弃原型或调用继承的 toJSON。 */
import { copyJson, validateJson } from '../../../src/kernel/memory/json';
import { harness, marker, spec } from './harness';

class CustomArray extends Array<number> {}

test.each([
  ['数组子类', () => new CustomArray(1, 2)],
  ['自定义原型', () => Object.setPrototypeOf([1, 2], Object.create(Array.prototype)) as number[]],
  ['无原型数组', () => Object.setPrototypeOf([1, 2], null) as number[]],
] as const)('拒绝%s，包含嵌套输入', (_name, create) => {
  const value = create();
  expect(() => validateJson(value)).toThrow(TypeError);
  expect(() => copyJson(value)).toThrow(TypeError);
  expect(() => copyJson({ nested: [value] })).toThrow(TypeError);
});

test('普通数组可复制；set/replace 拒绝数组子类且不改变旧数据', () => {
  const plain = [1, 2];
  expect(copyJson(plain)).toEqual(plain);
  expect(copyJson(plain)).not.toBe(plain);
  const h = harness();
  h.tick(1, () => {
    h.memory.initialize(marker);
    const a = h.memory.partitions('o').partition('a', spec);
    expect(() => a.set(['list'], new CustomArray(8, 9))).toThrow(TypeError);
    expect(() => a.replace({ ...spec.initialize(), list: new CustomArray(8, 9) })).toThrow(TypeError);
    expect(a.root()).toEqual(spec.initialize());
    h.memory.commit();
  });
});

test('update 改为数组子类后该单元被隔离，不调用继承的 toJSON，修复后可重试', () => {
  const convert = jest.fn(() => 'converted');
  class ConvertingArray extends Array<number> {
    toJSON() { return convert(); }
  }
  const h = harness();
  h.tick(1, () => {
    h.memory.initialize(marker);
    h.memory.partitions('o').partition('a', spec);
    h.memory.commit();
  });
  const before = h.platform.memory;
  const writes = h.write.mock.calls.length;
  h.tick(2, () => {
    const a = h.memory.partitions('o').partition('a', spec);
    a.update(['list'], (draft) => { Object.setPrototypeOf(draft, ConvertingArray.prototype); });
    expect(h.memory.commit()).toBe(false);
  });
  expect(convert).not.toHaveBeenCalled();
  expect(h.write).toHaveBeenCalledTimes(writes);
  expect(h.platform.memory).toBe(before);
  h.tick(3, () => {
    const a = h.memory.partitions('o').partition('a', spec);
    a.update(['list'], (draft) => { Object.setPrototypeOf(draft, Array.prototype); draft.push(3); });
    expect(h.memory.commit()).toBe(true);
  });
  expect(JSON.parse(h.platform.memory).leviathan.part.o.a.data.list).toEqual([1, 2, 3]);
});
