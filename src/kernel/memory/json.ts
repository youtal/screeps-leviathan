/**
 * 文件摘要：kernel.memory 的 JSON 校验与复制，供写入、迁移和提交共用。
 * 输入任意值，拒绝 JSON 无法无损表示的结构；复制时不共享可变引用。
 * 只接受普通对象/数组，不调用 getter 或 toJSON；字段可以缺省，但显式 undefined 与数组空洞均拒绝。
 * 递归集合仅记录当前祖先链，共享但不循环的子对象合法；每次调用结束释放，无跨 tick 状态。
 * 设计见 docs/design/kernel/memory.md。复杂度与值大小成正比，仅在实际写入/脏编码时使用。
 */
import type { Json } from "@/contracts/memory";

/**
 * @description 判断输入是否为非 null、非数组的普通对象或无原型字典；不递归校验其属性。
 * @param value 待判断的值。
 * @returns 满足对象条件时返回 true，否则返回 false；true 同时收窄输入类型。
 */
export const isObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * @description 校验与复制共用递归规则，避免写入接受的数据在提交阶段又被另一套规则拒绝。
 * ancestors 只含当前递归栈上的对象：同一子对象被兄弟字段引用合法，回指祖先才是循环。
 * 校验模式不创建副本；复制模式按 JSON 树展开共享引用，不保留输入对象的引用身份。
 * @param value 当前递归节点的值。
 * @param copy 是否在校验过程中构造副本。
 * @param ancestors 当前祖先对象集合；进入节点时加入，离开时移除。
 * @returns 校验模式返回原值，复制模式返回与输入隔离的 JSON 值。
 * @throws {TypeError} 值不符合 JSON 约束、数组原型非标准、含循环引用或不支持的属性描述符。
 */
const walk = (value: unknown, copy: boolean, ancestors: Set<object>): Json => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object")
    throw new TypeError("不是合法 JSON 值");
  // 每个容器只判断一次数组身份、读取一次原型；不跨调用缓存，update 后必须重新校验。
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new TypeError("JSON 只允许普通对象或普通数组");
  if (ancestors.has(value)) throw new TypeError("JSON 不允许循环引用");
  ancestors.add(value);
  try {
    const result: Record<string, Json | undefined> | Json[] | undefined = copy
      ? array
        ? []
        : {}
      : undefined;
    // Object.keys 会漏掉 symbol/不可枚举属性；读取描述符可拒绝 getter 而不执行其副作用。
    const keys = Reflect.ownKeys(value);
    // 稠密数组有 length 个元素键及一个 length 属性；后续逐键校验排除附加属性补足空洞的情况。
    if (array && keys.length !== value.length + 1)
      throw new TypeError("JSON 数组不允许空洞或附加属性");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") throw new TypeError("JSON 不允许 symbol 键");
      if (
        array &&
        (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
      ) {
        throw new TypeError("JSON 数组下标非法");
      }
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in property) || !property.enumerable)
        throw new TypeError("JSON 不允许访问器或不可枚举属性");
      // 对象和数组使用同一规则，拒绝 undefined，避免编码时静默省略字段或转换为 null。
      const item = walk(property.value, copy, ancestors);
      // defineProperty 不触发 __proto__ setter，普通 JSON 键不会污染原型。
      if (copy)
        Object.defineProperty(result!, key, {
          value: item,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    return (copy ? result : value) as Json;
  } finally {
    ancestors.delete(value);
  }
};

/**
 * @description 在写入或编码前递归校验 JSON 结构，不改变输入。
 * @param value 待校验的值。
 * @returns 无返回值；正常结束表示校验通过。
 * @throws {TypeError} 输入含非法 JSON 值、循环引用、数组空洞或不支持的属性。
 */
export const validateJson = (value: unknown): void => {
  walk(value, false, new Set());
};
/**
 * @description 校验并复制 JSON 树，隔离调用方持有的引用；共享子对象按树展开。
 * @template T 输入及副本的静态类型；运行时仍按 JSON 约束校验。
 * @param value 待复制的值。
 * @returns 与输入不共享可变对象的副本。
 * @throws {TypeError} 输入不符合 JSON 约束。
 */
export const copyJson = <T>(value: T): T => walk(value, true, new Set()) as T;

/**
 * @description 拒绝空串和危险原型键；toString 等仍合法，查表须另用 hasOwn 避免继承歧义。
 * @param key 用作命名空间、owner、分区或实体名称的键。
 * @returns 无返回值；正常结束表示键合法。
 * @throws {TypeError} 输入不是非空字符串或属于禁止使用的原型键。
 */
export const checkKey = (key: string): void => {
  if (
    typeof key !== "string" ||
    !key ||
    ["__proto__", "prototype", "constructor"].includes(key)
  ) {
    throw new TypeError("存储键非法");
  }
};
