/**
 * 文件摘要：持久化访问接口（src/contracts/memory.ts）的类型测试。
 * 断言在类型检查阶段生效（npm run typecheck 与 ts-jest 都会检查本文件）：合法路径推导出正确的值类型，
 * 非法路径、超过 8 段的路径与 interface 声明的数据类型被拒绝（以 @ts-expect-error 标注，未报错即检查失败）。
 * 运行时只确认类型断言函数存在，不调用任何 Accessor。
 */
import type { Accessor, DeepReadonly, Json, Path, UnitSpec, ValueAt } from '../../src/contracts/memory';

/** 两个类型严格相等时为 true。 */
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const expectType = <T extends true>(): T => true as T;

type Site = {
  pos: { x: number; y: number };
  tasks: { a: string; id?: string }[];
  stats?: { mined: number };
  byRoom: { [room: string]: number };
};

type Deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: number } } } } } } } } };

interface NotJson {
  x: number;
}

const typeChecks = (site: Accessor<Site>, deep: Accessor<Deep>): void => {
  expectType<Equal<ValueAt<Site, ['pos', 'x']>, number>>();
  expectType<Equal<ValueAt<Site, ['tasks', 0, 'id']>, string | undefined>>();
  expectType<Equal<ValueAt<Site, ['stats']>, { mined: number } | undefined>>();
  expectType<Equal<ValueAt<Site, ['stats', 'mined']>, number>>();
  expectType<Equal<ValueAt<Site, ['byRoom', 'W1N1']>, number>>();

  // 调用时从数组字面量推导出字面量元组，返回只读引用。
  const pos = site.get(['pos']);
  expectType<Equal<typeof pos, DeepReadonly<{ x: number; y: number }> | undefined>>();
  site.set(['tasks', 2, 'a'], 'harvest');
  site.update(['stats'], (draft) => {
    if (draft) {
      draft.mined += 1;
    }
  });
  const route = ['byRoom', 'W2N2'] as const;
  site.set(route, 3);

  // @ts-expect-error 不存在的键
  site.get(['pos', 'z']);
  // @ts-expect-error 对象键不能用数字段
  site.get(['pos', 0]);
  // @ts-expect-error 值类型不符
  site.set(['pos', 'x'], 'one');
  // @ts-expect-error 路径至少一段
  site.get([]);

  deep.get(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  // @ts-expect-error 路径最多 8 段
  deep.get(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);

  const okSpec: UnitSpec<Site> = { version: 1, initialize: () => ({ pos: { x: 0, y: 0 }, tasks: [], byRoom: {} }), migrate: (data) => data as Site };
  // @ts-expect-error interface 没有隐式索引签名，不满足 Json 约束；持久数据类型须用 type 别名
  const badSpec: UnitSpec<NotJson> = { version: 1, initialize: () => ({ x: 0 }), migrate: () => ({ x: 0 }) };
  const json: Json = okSpec.initialize();
  void [badSpec, json];
};

type Unused = Path<Site>;

test('持久化访问接口的类型断言通过类型检查', () => {
  const unused: Unused | undefined = undefined;
  expect(typeof typeChecks).toBe('function');
  expect(unused).toBeUndefined();
});
