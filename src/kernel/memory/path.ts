/**
 * 文件摘要：kernel.memory 的路径校验、读取和原地写入，不管理单元身份或脏状态。
 * 输入根值和长度 1–8 的元组；只遍历自有属性，拒绝原型相关键和非整数下标。
 * create 仅建立普通对象，缺失分支在完整构造成功后才接回根，失败不留下半条路径。
 * 数组长度固定，删除元素须由 update/splice 完成。函数无跨 tick 状态，复杂度 O(路径长度)。
 */
import type { Json, PathSegment } from '../../contracts/memory';
import { isObject } from './json';

/** 存储内部可变视图；对外 Json 是只读类型，写入权只由 Accessor 授予。 */
type Container = Json[] | { [key: string]: Json | undefined };

/**
 * @description 校验路径长度、段类型与危险键，不访问根数据。
 * @param path 待校验的 1–8 段路径。
 * @returns 无返回值；正常结束表示路径形状合法，尚未确认与实际容器匹配。
 * @throws {TypeError} 路径为空、过长、含危险键或非法数组下标。
 */
export const checkPath = (path: readonly PathSegment[]): void => {
  if (!Array.isArray(path) || path.length < 1 || path.length > 8) throw new TypeError('路径需要 1–8 段');
  for (const key of path) {
    if (typeof key === 'string') {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('禁止危险路径键');
    } else if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0 || key >= 2 ** 32 - 1) {
      throw new TypeError('数组下标必须是非负整数');
    }
  }
};

/**
 * @description 判断输入是否可作为路径遍历的数组或普通对象容器。
 * @param value 待判断的值。
 * @returns 可遍历时为 true，并收窄为内部可变容器类型。
 */
const container = (value: unknown): value is Container => Array.isArray(value) || isObject(value);
/**
 * @description 检查路径段与容器的匹配关系，不做隐式键转换。
 * @param value 当前路径父容器。
 * @param key 当前路径段；数组要求数字，对象要求字符串。
 * @returns 无返回值；正常结束表示类型匹配。
 * @throws {TypeError} 数组使用字符串键或对象使用数字键。
 */
const checkSegment = (value: Container, key: PathSegment): void => {
  if (Array.isArray(value) ? typeof key !== 'number' : typeof key !== 'string') {
    throw new TypeError('路径段与容器类型不符');
  }
};
/**
 * @description 读取容器字段；调用方须先确认段类型与自有属性，类型断言仅统一索引语法。
 * @param value 已确认的父容器。
 * @param key 与容器类型匹配的字段或下标。
 * @returns 对应字段值，字段值可为 undefined。
 */
const read = (value: Container, key: PathSegment): Json | undefined =>
  (value as Record<PathSegment, Json | undefined>)[key];

/**
 * @description 沿自有属性读取路径；调用方须先 checkPath，防止缺失分支跳过危险键校验。
 * @param root 存储单元根值。
 * @param path 已通过形状校验的路径。
 * @returns 对应原始引用或标量；路径缺失或中途不再是容器时返回 undefined。
 * @throws {TypeError} 路径段与实际容器类型不符。
 */
export const getAt = (root: Json, path: readonly PathSegment[]): Json | undefined =>
  getUntil(root, path, path.length);

/**
 * @description 在原路径上遍历指定前缀，避免 has/delete 为父路径分配切片数组。
 * @param root 存储单元根值。
 * @param path 已通过 checkPath 的完整路径。
 * @param end 遍历终点（不包含）；由内部调用方提供 0 到 path.length 的整数。
 * @returns 前缀对应的原值；end 为 0 时返回 root，缺失时返回 undefined。
 * @throws {TypeError} 已遍历路径段与实际容器类型不匹配。
 */
const getUntil = (root: Json, path: readonly PathSegment[], end: number): Json | undefined => {
  let value: Json | undefined = root;
  for (let index = 0; index < end; index += 1) {
    const key = path[index];
    if (!container(value)) return undefined;
    checkSegment(value, key);
    if (!Object.hasOwn(value, key)) return undefined;
    value = read(value, key);
  }
  return value;
};

/**
 * @description 判断末段自有键是否存在，不判断其值能否持久化。
 * update 后暂存的显式 undefined 字段仍算存在，但 commit 会拒绝该非法值。
 * @param root 存储单元根值。
 * @param path 已通过 checkPath 的路径。
 * @returns 末段自有键存在时为 true；父路径或末段键缺失时为 false。
 * @throws {TypeError} 路径段与实际容器类型不符。
 */
export const hasAt = (root: Json, path: readonly PathSegment[]): boolean => {
  const parent = getUntil(root, path, path.length - 1);
  if (!container(parent)) return false;
  const key = path[path.length - 1];
  checkSegment(parent, key);
  return Object.hasOwn(parent, key);
};

/**
 * @description 调用方已校验路径并复制 value；本函数只定位与写入，不承担复制或标脏。
 * 最多递归八层。已有分支只读到末端再写，缺失分支先离线构造，错误不会残留半条新路径。
 * @param root 待原地修改的单元根值。
 * @param path 已通过 checkPath 的写入路径。
 * @param value 已校验并与外部引用隔离的写入值。
 * @param create 是否为缺失中间路径创建普通对象；不会创建或扩容数组。
 * @returns 无返回值；成功时修改 root 中的目标字段。
 * @throws {TypeError} 父节点不是容器，或路径段类型不匹配。
 * @throws {RangeError} 数组下标不存在或超出长度。
 * @throws {Error} 中间路径缺失且不允许创建。
 */
export const setAt = (root: Json, path: readonly PathSegment[], value: Json, create: boolean): void => {
  /**
   * @description 递归定位末段；新建分支完成后才接回父容器。
   * @param parent 当前层的父节点。
   * @param index 当前路径段的零基下标。
   * @returns 无返回值；成功时原地写入目标字段。
   * @throws {Error} 容器、路径段或创建条件不满足 setAt 的约束。
   */
  const write = (parent: Json, index: number): void => {
    if (!container(parent)) throw new TypeError('路径父节点不是容器');
    const key = path[index];
    checkSegment(parent, key);
    // checkSegment 已确认数组键为数字；断言只传达该事实，不进行运行时转换。
    if (Array.isArray(parent) && ((key as number) >= parent.length || !Object.hasOwn(parent, key))) {
      throw new RangeError('set 不扩容数组');
    }
    if (index === path.length - 1) {
      (parent as Record<PathSegment, Json>)[key] = value;
      return;
    }
    if (!Object.hasOwn(parent, key)) {
      // 下一段为数字意味着需要数组，create 不猜测数组大小；已有 undefined 也不视作缺失键。
      if (!create || typeof path[index + 1] !== 'string') throw new Error('中间路径缺失');
      const branch = {};
      write(branch, index + 1);
      (parent as Record<PathSegment, Json>)[key] = branch;
    } else {
      const next = read(parent, key);
      if (next === undefined) throw new TypeError('中间路径不是容器');
      write(next, index + 1);
    }
  };
  write(root, 0);
};

/**
 * @description 删除对象自有字段，不裁剪空父容器，也不通过 delete 制造数组空洞。
 * @param root 待修改的单元根值。
 * @param path 已通过 checkPath 的删除路径。
 * @returns 成功删除时为 true，路径或字段缺失时为 false。
 * @throws {TypeError} 尝试删除已有数组元素，或路径段与容器类型不匹配。
 */
export const deleteAt = (root: Json, path: readonly PathSegment[]): boolean => {
  const parent = getUntil(root, path, path.length - 1);
  if (!container(parent)) return false;
  const key = path[path.length - 1];
  checkSegment(parent, key);
  if (!Object.hasOwn(parent, key)) return false;
  if (Array.isArray(parent)) throw new TypeError('数组元素请用 update/splice 删除');
  // 数组已排除且 checkSegment 已确认字符串键，不再重复转换。
  return delete (parent as { [key: string]: Json | undefined })[key as string];
};
