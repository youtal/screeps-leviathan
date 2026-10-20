/**
 * 文件摘要：lib.hash 的单元测试。
 * 覆盖：固定向量（冻结算法：校验位随名称持久存在，任何改动都会使这些断言失败）、无符号 32 位范围、
 * 相邻输入在小模数下的分布。固定向量另经独立的 Python 实现核对（FNV-1a 32 位加 fmix32）。
 */
import { hashString } from '@/lib/hash';

test('固定向量：算法发布后不得改变', () => {
  expect(['', 'a', 'leviathan', 'lv-shard0-hv-x-18nrw9.2', '中文'].map(hashString))
    .toEqual([2872998923, 444641715, 3065891564, 3908222805, 970441454]);
});

test('结果为 0 到 2^32 − 1 的整数', () => {
  for (const text of ['x', 'W1N1', 'a'.repeat(1000), '￿\u0000']) {
    const h = hashString(text);
    expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true);
  }
});

test('相邻输入取模 36 与 10 时分布均匀', () => {
  // 相邻序号只差末位字符，是校验位与错峰的典型输入；每个桶的计数应接近均值。
  const n = 36000;
  const by36 = new Array<number>(36).fill(0);
  const by10 = new Array<number>(10).fill(0);
  for (let i = 0; i < n; i += 1) {
    const h = hashString(`lv-shard0-hv-x-18nrw9.${i.toString(36)}`);
    by36[h % 36] += 1;
    by10[h % 10] += 1;
  }
  expect(Math.min(...by36)).toBeGreaterThan(n / 36 * 0.85);
  expect(Math.max(...by36)).toBeLessThan(n / 36 * 1.15);
  expect(Math.min(...by10)).toBeGreaterThan(n / 10 * 0.95);
  expect(Math.max(...by10)).toBeLessThan(n / 10 * 1.05);
});
