/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的深路径解析工具，供访问器的 get、路径 commit 与 remove 调用。
 *
 * 主要功能：规范化“顶层键或路径数组”入参；按设计 §4.1 的读写边界在分区根上定位目标——
 * 读取缺失返回 undefined，写入要求中间容器全部存在，删除只作用于对象属性。
 *
 * 实现过程：三个定位函数逐段下降。每一段只访问自有属性：对象用字符串键，数组用非负整数下标
 * 且必须指向已有元素；穿越 null/基本值或段类型与容器不匹配一律抛错，不自动创建、不扩容。
 *
 * 技术要点：不修改数据、不标脏，也不做 JSON 值校验（由调用方用 validate.ts 完成），因此预检失败
 * 不会留下任何修改。成本 O(路径长度)；写入定位额外返回途经容器，供新值的“祖先引用”检查。
 * 路径数组不复制，调用方可复用 `as const` 常量。
 */
import { isReservedKey } from './validate';

type Segment = string | number;
const hasOwn = Object.prototype.hasOwnProperty;

/** 路径错误属于调用错误，直接抛出；消息带上已规范化的路径便于定位。 */
const pathError = (path: readonly Segment[], reason: string): Error =>
  new Error('MemoryManager: invalid path ' + JSON.stringify(path) + ': ' + reason);

/**
 * 把入参规范化为路径数组并校验每一段。
 * - 字符串表示一个完整顶层键，不按点号拆分；
 * - 数组必须非空，字符串段拒绝原型相关保留键，数字段必须是非负安全整数。
 */
export const normalizePath = (keyOrPath: unknown): readonly Segment[] => {
  const path: readonly unknown[] =
    typeof keyOrPath === 'string' ? [keyOrPath] : (keyOrPath as unknown[]);
  if (!Array.isArray(path) || path.length === 0)
    throw new Error('MemoryManager: path must be a key string or a non-empty array');
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (isReservedKey(segment))
        throw pathError(path as Segment[], 'reserved key ' + segment);
    } else if (
      typeof segment !== 'number' ||
      !Number.isSafeInteger(segment) ||
      segment < 0
    ) {
      throw pathError(path as Segment[], 'segment ' + String(segment) + ' is not a key or index');
    }
  }
  return path as readonly Segment[];
};

/** 容器与段的类型匹配：数组只接受数字，普通对象只接受字符串。 */
const checkSegmentKind = (
  container: object,
  segment: Segment,
  path: readonly Segment[]
): void => {
  if (Array.isArray(container)) {
    if (typeof segment !== 'number')
      throw pathError(path, 'array requires a numeric index, got ' + JSON.stringify(segment));
  } else if (typeof segment !== 'string') {
    throw pathError(path, 'object requires a string key, got ' + segment);
  }
};

/** 自有成员是否存在；数组下标额外要求落在长度内。 */
const hasMember = (container: object, segment: Segment): boolean =>
  Array.isArray(container)
    ? (segment as number) < container.length && hasOwn.call(container, segment)
    : hasOwn.call(container, segment);

/** 下一层必须是对象容器；null 与基本值不可穿越。 */
const asContainer = (value: unknown, path: readonly Segment[], depth: number): object => {
  if (value === null || typeof value !== 'object')
    throw pathError(path, 'cannot traverse ' + (value === null ? 'null' : typeof value) + ' at segment ' + depth);
  return value;
};

/**
 * 读取定位：缺失的中间层或目标返回 undefined；穿越已存在的基本值、段类型不匹配抛错。
 */
export const readPath = (root: object, path: readonly Segment[]): unknown => {
  let current: object = root;
  for (let depth = 0; depth < path.length; depth++) {
    const segment = path[depth];
    checkSegmentKind(current, segment, path);
    if (!hasMember(current, segment)) return undefined;
    const value = (current as Record<Segment, unknown>)[segment];
    if (depth === path.length - 1) return value;
    current = asContainer(value, path, depth + 1);
  }
  return undefined;
};

/** 写入定位结果：parent 是目标所在容器，ancestors 是从根到 parent 的全部途经容器。 */
export interface WriteTarget {
  parent: object;
  key: Segment;
  ancestors: object[];
}

/**
 * 写入定位：所有中间容器必须已经存在；数组目标下标必须指向已有元素（不扩容、不制造空洞），
 * 对象目标键允许新增。任何不满足都抛错，且此时尚未修改数据。
 */
export const locateWrite = (root: object, path: readonly Segment[]): WriteTarget => {
  const ancestors: object[] = [root];
  let current: object = root;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const segment = path[depth];
    checkSegmentKind(current, segment, path);
    if (!hasMember(current, segment))
      throw pathError(path, 'missing intermediate container at segment ' + depth);
    current = asContainer((current as Record<Segment, unknown>)[segment], path, depth + 1);
    ancestors.push(current);
  }
  const key = path[path.length - 1];
  checkSegmentKind(current, key, path);
  if (Array.isArray(current) && !hasMember(current, key))
    throw pathError(path, 'array index ' + key + ' is out of range');
  return { parent: current, key, ancestors };
};

/**
 * 删除定位：返回目标所在的普通对象与键；中间层或目标缺失返回 null（调用方返回 false）。
 * 目标容器是数组时抛错——数组元素删除会移位或留下空洞，只能在回调中显式 splice。
 */
export const locateRemove = (
  root: object,
  path: readonly Segment[]
): { parent: Record<string, unknown>; key: string } | null => {
  let current: object = root;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const segment = path[depth];
    checkSegmentKind(current, segment, path);
    if (!hasMember(current, segment)) return null;
    current = asContainer((current as Record<Segment, unknown>)[segment], path, depth + 1);
  }
  const key = path[path.length - 1];
  if (Array.isArray(current))
    throw pathError(path, 'array elements cannot be removed by path; splice in a commit callback');
  checkSegmentKind(current, key, path);
  if (!hasOwn.call(current, key)) return null;
  return { parent: current as Record<string, unknown>, key: key as string };
};
