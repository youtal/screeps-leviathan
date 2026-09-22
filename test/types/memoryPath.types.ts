/**
 * 文件摘要：MemoryAccessor 深路径类型的编译期正负例；由 tsc 检查，不由 Jest 执行。
 *
 * 覆盖设计 §4.2 的类型验收：字符串顶层键、可选对象、动态 Record、readonly 元组、
 * 数组与元组下标、联合类型、必填属性删除、错误值与错误路径。负例用 `@ts-expect-error`
 * 固定，任何放宽都会让 tsc 报“未使用的 expect-error”。
 */
import type { MemoryAccessor } from '@/contracts';

interface Room {
  level: number;
  note?: string;
  links: string[];
}
interface State {
  count: number;
  config?: { enabled: boolean; limit: number };
  rooms: Record<string, Room>;
  pair: [number, string];
  list: { v: number }[];
  shape: { kind: 'a'; a: number } | { kind: 'b'; b: string };
  maybeNull: { x: number } | null;
  'dotted.key': number;
}

export function positive(m: MemoryAccessor<State>, roomName: string, i: number) {
  const n: number | undefined = m.get('count');
  const lvl: number | undefined = m.get(['rooms', roomName, 'level']);
  const cfg = m.get(['config', 'enabled']);
  const first: number | undefined = m.get(['pair', 0]);
  const second: string | undefined = m.get(['pair', 1]);
  const v = m.get(['list', i, 'v']);
  const dotted: number | undefined = m.get('dotted.key');
  const ab = m.get(['shape', 'a']);
  void [n, lvl, cfg, first, second, v, dotted, ab];

  m.commit('count', 3);
  m.commit('config', { enabled: true, limit: 10 });
  m.commit(['config', 'enabled'], true);
  m.commit(['rooms', roomName], { level: 1, links: [] });
  m.commit(['rooms', 'W1N1', 'level'], 2);
  m.commit(['rooms', roomName, 'note'], 'hi');
  m.commit(['rooms', roomName, 'links', 0], 'id');
  m.commit(['pair', 1], 'x');
  m.commit(['list', i], { v: 1 });
  m.commit(['shape', 'b'], 'text');
  m.commit(['maybeNull', 'x'], 5);
  m.commit('maybeNull', null);
  const path = ['rooms', roomName, 'level'] as const;
  m.commit(path, 4);
  const r: number = m.commit((s) => ++s.count);
  void r;

  const removed: boolean = m.remove('config');
  m.remove(['rooms', roomName]);
  m.remove(['rooms', roomName, 'note']);
  m.remove(['rooms', 'W1N1']); // 字面量 Record 键同样是动态条目
  m.remove(['config']);
  void removed;
}

export function negative(m: MemoryAccessor<State>, roomName: string, wide: string[]) {
  // @ts-expect-error 缺少必填字段的可选对象不能整体赋值
  m.commit('config', { enabled: true });
  // @ts-expect-error 值类型错误
  m.commit('count', 'x');
  // @ts-expect-error 不能用 undefined 表达删除（strict 下编译期拒绝，运行时 JSON 校验同样拒绝）
  m.commit('config', undefined);
  // @ts-expect-error 未声明的顶层键
  m.commit('missing', 1);
  // @ts-expect-error 深路径值类型错误
  m.commit(['rooms', roomName, 'level'], 'high');
  // @ts-expect-error 深路径中间键不存在
  m.commit(['rooms', roomName, 'nope'], 1);
  // @ts-expect-error 数组方法名不是合法路径
  m.get(['list', 'length']);
  // @ts-expect-error 数组段必须是数字下标
  m.get(['rooms', roomName, 'links', 'push']);
  // @ts-expect-error 元组越界下标
  m.get(['pair', 2]);
  // @ts-expect-error 对象键不能用数字段
  m.get(['rooms', 0]);
  // @ts-expect-error 空路径不代表整个分区
  m.commit([], {});
  // @ts-expect-error 宽数组无法逐段校验
  m.get(wide);
  // @ts-expect-error 穿越基本值
  m.commit(['count', 'x'], 1);
  // @ts-expect-error 静态必填属性不能删除
  m.remove('count');
  // @ts-expect-error 深路径必填属性不能删除
  m.remove(['rooms', roomName, 'level']);
  // @ts-expect-error 数组元素不通过路径删除
  m.remove(['list', 0]);
  // @ts-expect-error 联合类型中任何分支都没有该键
  m.commit(['shape', 'c'], 1);
  // @ts-expect-error 查询结果深只读
  m.query().rooms[roomName].level++;
  const room = m.get(['rooms', roomName]);
  // @ts-expect-error get 结果深只读
  if (room) room.links.push('x');
}

/** 超过递归预算的路径在类型层非法，需改用回调修改。 */
type Deep = { a: { a: { a: { a: { a: { a: { a: { a: { a: number } } } } } } } } };
export function depth(m: MemoryAccessor<Deep>) {
  m.commit(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a'], { a: 1 });
  // @ts-expect-error 9 段超过 MaxPathDepth
  m.commit(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a'], 1);
  m.commit((s) => (s.a.a.a.a.a.a.a.a.a = 1));
}

/** any 是显式的动态入口：放弃路径检查，运行时校验照常。 */
export function dynamic(m: MemoryAccessor<any>, path: (string | number)[]) {
  m.get(['anything', 0, 'deep']);
  m.commit(['x', 'y'], 1);
  m.remove(['x', 'y']);
  // 宽数组仍然无法静态收窄为元组，需要显式断言。
  m.get(path as unknown as readonly [string]);
}

/** M6：数字索引 Record 用字符串段访问；带索引签名时静态必填键仍不可删除。 */
interface History {
  byTick: Record<number, { cpu: number }>;
  [extra: string]: unknown;
}
interface Mixed {
  count: number;
  label?: string;
  [key: string]: number | string | undefined;
}
export function indexSignatures(h: MemoryAccessor<History>, m: MemoryAccessor<Mixed>, tick: number) {
  const cpu: number | undefined = h.get(['byTick', String(tick), 'cpu']);
  void cpu;
  h.commit(['byTick', String(tick)], { cpu: 1 });
  h.remove(['byTick', String(tick)]);
  // @ts-expect-error 对象段必须是字符串（运行时同样拒绝数字段）
  h.get(['byTick', tick]);
  m.remove('label');
  m.remove('anyDynamicKey');
  // @ts-expect-error 索引签名不能放行静态必填键
  m.remove('count');
}

/** N6：数字索引记录作为分区根时，键重载与路径重载一致。 */
export function numericRoot(m: MemoryAccessor<Record<number, { cpu: number }>>) {
  const byKey: { readonly cpu: number } | undefined = m.get('100');
  const byPath: number | undefined = m.get(['100', 'cpu']);
  m.commit('100', { cpu: 1 });
  m.remove('100');
  // @ts-expect-error 键重载同样检查值类型
  m.commit('100', { cpu: 'x' });
  void [byKey, byPath];
}
