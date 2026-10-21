/** kernel.intershard：特性检测与本 shard 清空。 */
import { createInterShard } from '@/kernel/intershard';

test('没有 InterShardMemory 时不可用，清空什么也不做', () => {
  const host = createInterShard({});
  expect(host.available()).toBe(false);
  expect(() => host.clearLocal()).not.toThrow();
});

test('可用时写入空字符串；在调用时检测，不在创建时', () => {
  const target: { InterShardMemory?: { setLocal: jest.Mock } } = {};
  const host = createInterShard(target);
  target.InterShardMemory = { setLocal: jest.fn() };
  expect(host.available()).toBe(true);
  host.clearLocal();
  expect(target.InterShardMemory.setLocal).toHaveBeenCalledWith('');
});

test('平台异常原样传播', () => {
  const host = createInterShard({ InterShardMemory: { setLocal: () => { throw new Error('平台拒绝'); } } });
  expect(() => host.clearLocal()).toThrow('平台拒绝');
});
