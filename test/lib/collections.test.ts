/**
 * 文件摘要：lib.collections 的单元测试。
 * 覆盖：PriorityQueue 与排序结果对拍（逐个 push 与 from 建堆两种方式、对象元素与次序键）、空队列与 clear；
 * BucketQueue 的桶序与桶内先进先出、出队后向更小桶号 push 时游标回退、peekBucket、参数校验与复用；
 * LruCache 的淘汰顺序、get 刷新与 peek 不刷新、值为 undefined 的条目、淘汰回调只在超出容量时调用、参数校验。
 * 泛型：以显式类型的赋值在类型检查中确认元素、键、值类型的推断（tsconfig.test.json）。
 */
import { BucketQueue, LruCache, PriorityQueue } from '@/lib/collections';
import type { Comparator } from '@/lib/collections';

/**
 * @description mulberry32 伪随机数，测试可复现。
 * @param seed 种子。
 * @returns 返回 [0, 1) 浮点数的函数。
 */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 测试用的孵化请求。 */
interface Request {
  readonly owner: string;
  readonly priority: number;
  readonly deadline: number;
  readonly seq: number;
}

/** 优先级高者先，同优先级 deadline 早者先，再按入队序号，保证全序。 */
const byRequest: Comparator<Request> = (a, b) => b.priority - a.priority || a.deadline - b.deadline || a.seq - b.seq;

test('PriorityQueue 的出队顺序与排序一致（push 与 from 两种建堆）', () => {
  const r = random(7);
  for (let n = 0; n <= 200; n += 13) {
    const items: Request[] = Array.from({ length: n }, (_, seq) => ({
      owner: `o${seq}`, priority: Math.floor(r() * 5), deadline: Math.floor(r() * 50), seq,
    }));
    const expected = [...items].sort(byRequest);
    const pushed = new PriorityQueue<Request>(byRequest);
    for (const item of items) pushed.push(item);
    const built = PriorityQueue.from(items, byRequest);
    for (const q of [pushed, built]) {
      expect(q.size).toBe(n);
      const out: Request[] = [];
      for (let item = q.pop(); item !== undefined; item = q.pop()) out.push(item);
      expect(out).toEqual(expected);
      expect(out.every((x, i) => x === expected[i])).toBe(true);
      expect(q.size).toBe(0);
    }
  }
});

test('PriorityQueue 交替 push 与 pop，peek、clear 与空队列', () => {
  const q = new PriorityQueue<number>((a, b) => a - b);
  expect(q.pop()).toBeUndefined();
  expect(q.peek()).toBeUndefined();
  const r = random(3);
  const ref: number[] = [];
  for (let k = 0; k < 500; k += 1) {
    if (r() < 0.6) {
      const v = Math.floor(r() * 100);
      q.push(v);
      ref.push(v);
      ref.sort((a, b) => a - b);
    } else {
      expect(q.peek()).toBe(ref[0]);
      expect(q.pop()).toBe(ref.shift());
    }
    expect(q.size).toBe(ref.length);
  }
  q.clear();
  expect([q.size, q.pop()]).toEqual([0, undefined]);
  q.push(5);
  expect(q.pop()).toBe(5);
  // 泛型推断：元素类型由比较函数与 from 的输入决定。
  const names = PriorityQueue.from(['b', 'a'], (a, b) => a.localeCompare(b));
  const first: string | undefined = names.pop();
  expect(first).toBe('a');
});

test('BucketQueue 先取桶号小的桶，桶内先进先出', () => {
  const q = new BucketQueue<{ id: string }>(5);
  expect([q.levels, q.size, q.pop(), q.peekBucket()]).toEqual([5, 0, undefined, -1]);
  const order: [string, number][] = [['a', 3], ['b', 1], ['c', 3], ['d', 0], ['e', 1], ['f', 4]];
  for (const [id, bucket] of order) q.push({ id }, bucket);
  expect(q.size).toBe(6);
  expect(q.peekBucket()).toBe(0);
  expect([q.pop()?.id, q.pop()?.id]).toEqual(['d', 'b']);
  // 出队后向更小的桶号 push：游标回退到该桶。
  q.push({ id: 'g' }, 0);
  expect(q.peekBucket()).toBe(0);
  const rest: string[] = [];
  for (let item = q.pop(); item !== undefined; item = q.pop()) rest.push(item.id);
  expect(rest).toEqual(['g', 'e', 'a', 'c', 'f']);
  expect(q.size).toBe(0);
});

test('BucketQueue 与稳定排序对拍，clear 后可复用', () => {
  const r = random(11);
  const q = new BucketQueue<number>(8);
  for (let round = 0; round < 3; round += 1) {
    const items = Array.from({ length: 300 }, (_, i) => ({ v: i, b: Math.floor(r() * 8) }));
    for (const { v, b } of items) q.push(v, b);
    // Array.prototype.sort 是稳定排序，桶内保持入队顺序。
    const expected = [...items].sort((x, y) => x.b - y.b).map((x) => x.v);
    const half: number[] = [];
    for (let k = 0; k < 150; k += 1) half.push(q.pop() as number);
    expect(half).toEqual(expected.slice(0, 150));
    q.clear();
    expect([q.size, q.pop()]).toEqual([0, undefined]);
  }
});

test('BucketQueue 参数校验', () => {
  expect(() => new BucketQueue(0)).toThrow(RangeError);
  expect(() => new BucketQueue(1.5)).toThrow(RangeError);
  const q = new BucketQueue<string>(2);
  expect(() => q.push('x', 2)).toThrow(RangeError);
  expect(() => q.push('x', -1)).toThrow(RangeError);
  expect(() => q.push('x', 0.5)).toThrow(RangeError);
  expect(q.size).toBe(0);
});

test('LruCache 淘汰最久未用的条目，get 刷新、peek 不刷新', () => {
  const evicted: [string, number][] = [];
  const cache = new LruCache<string, number>(3, (key, value) => evicted.push([key, value]));
  cache.set('a', 1).set('b', 2).set('c', 3);
  expect(cache.get('a')).toBe(1);
  expect(cache.peek('b')).toBe(2);
  cache.set('d', 4);
  expect(evicted).toEqual([['b', 2]]);
  expect([...cache.keys()]).toEqual(['c', 'a', 'd']);
  // 覆盖已有键：刷新顺序，不淘汰。
  cache.set('c', 30);
  expect([...cache.keys()]).toEqual(['a', 'd', 'c']);
  expect(evicted).toHaveLength(1);
  // delete 与 clear 不调用淘汰回调。
  expect(cache.delete('a')).toBe(true);
  expect(cache.delete('a')).toBe(false);
  cache.clear();
  expect([cache.size, evicted.length]).toEqual([0, 1]);
});

test('LruCache 区分值为 undefined 与没有该键', () => {
  const cache = new LruCache<number, string | undefined>(2);
  cache.set(1, undefined).set(2, 'x');
  expect([cache.has(1), cache.get(1), cache.has(3), cache.get(3)]).toEqual([true, undefined, false, undefined]);
  // get(1) 已刷新：再写入时淘汰 2。
  cache.set(3, 'y');
  expect([...cache.keys()]).toEqual([1, 3]);
  const value: string | undefined = cache.get(3);
  expect(value).toBe('y');
});

test('LruCache 参数校验', () => {
  expect(() => new LruCache(0)).toThrow(RangeError);
  expect(() => new LruCache(2.5)).toThrow(RangeError);
  expect(new LruCache<object, number>(1).capacity).toBe(1);
});
