/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的受管数据校验工具，供申请发布、路径写入与收尾提交调用。
 *
 * 主要功能：判断一个值是否满足受管 JSON 约束——null、布尔、有限数字、字符串、无空洞的普通
 * 数组和普通对象；拒绝 undefined、函数、Symbol、BigInt、NaN/Infinity、Map/Set/Date 等非普通
 * 对象、自定义 toJSON、对象上的访问器属性、Symbol 键及原型相关保留键。
 *
 * 实现过程：三种遍历模式共享同一套节点与成员规则（checkNode、forEachChild）：
 * - publish：只校验不复制，用于同版本历史数据（刚从片段解析出的对象，已与外界隔离）；
 *   祖先栈检出循环，已完成的子树记入 done 跳过。
 * - copy：校验的同时构造新对象，用于 initialize/migrate 返回值与路径写入的新值。调用方
 *   保留原对象的所有权，之后修改、冻结或复用它都不影响分区；同一值内部的共享子对象经 copies
 *   记忆表映射到同一个副本，既避免指数级重复遍历，也保持该值内部的引用关系。可传入“禁止
 *   引用集合”拒绝指向写入目标祖先的引用。
 * - end：收尾只对回调修改过的分区调用，用单个 seen 集合跳过已访问对象，既防止无限递归又
 *   避免重复遍历共享对象；不做独立环检测——循环由随后无 replacer 的 JSON.stringify 抛错。
 *
 * 技术要点：校验失败抛出带位置（如 `$.rooms["W1N1"].links[2]`）的 Error；位置由 trail 栈在
 * 出错时拼接，正常路径只做 push/pop。集合均为调用局部，调用结束即释放，不跨 tick 保存。
 * 每个对象属性读取一次属性描述符以识别访问器属性，每个容器查询一次 Symbol 键。实测（打包后
 * 在 Node 中运行，5000 个小对象）：收尾校验约为原生 stringify 的 2.4 倍，发布前校验约 3.3 倍；
 * copy 模式比只校验多约 35%，比“校验 + JSON 往返复制”少一次完整遍历。收尾阶段因此只对 needsFullValidation
 * 分区执行；成本随容器数量增长，大对象少、小对象多的数据倍数更高。
 *
 * 原型链上的可枚举属性（其它代码向 Object.prototype 添加的扩展）与 JSON.stringify 一致地
 * 忽略：它们不是分区数据，报错会让一处无关的原型扩展阻断全部持久化。
 *
 * 有意不检出（成本取舍，属于引用所有权契约下的违规用法）：数组元素上的访问器、数组的附加
 * 字符串属性、对象的不可枚举属性。前两者需要逐元素读取描述符或枚举全部键，大型数值数组上
 * 实测使校验成本增加约 10 倍；不可枚举属性检测在对象密集数据上约增加 15%。这些值会按原生
 * JSON.stringify 语义写出（getter 取当时的值，附加属性与不可枚举属性被省略）。
 */

const OBJECT_PROTO = Object.prototype;
const ARRAY_PROTO = Array.prototype;
const getProto = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getSymbols = Object.getOwnPropertySymbols;

/** 原型相关保留键：既不能作为路径段，也不能出现在受管对象中。 */
export const isReservedKey = (key: string): boolean =>
  key === '__proto__' || key === 'prototype' || key === 'constructor';

/** 普通对象：原型为 Object.prototype 或 null，且不是数组。 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const proto = getProto(value);
  return proto === OBJECT_PROTO || proto === null;
};

/** 把 trail 渲染成可读位置：字符串键用 JSON 引号，数字下标用方括号。 */
const renderTrail = (trail: (string | number)[]): string =>
  '$' +
  trail
    .map((segment) =>
      typeof segment === 'number'
        ? '[' + segment + ']'
        : /^[A-Za-z_$][\w$]*$/.test(segment)
          ? '.' + segment
          : '[' + JSON.stringify(segment) + ']'
    )
    .join('');

class JsonShapeError extends Error {}

const fail = (trail: (string | number)[], reason: string): never => {
  throw new JsonShapeError(renderTrail(trail) + ': ' + reason);
};

/**
 * 只校验模式的遍历状态。ancestors 是当前递归路径上的对象（检出循环），done 是已完整
 * 校验的对象（共享子对象只校验一次）。
 */
interface PublishState {
  ancestors: Set<object>;
  done: Set<object>;
  trail: (string | number)[];
}

/**
 * copy 模式的遍历状态：ancestors 检出循环；copies 记录已完成的“原对象 → 副本”，共享子对象
 * 复用同一副本；forbidden 是写入目标的祖先容器，新值引用其中任何一个都拒绝。
 */
interface CopyState {
  ancestors: Set<object>;
  copies: Map<object, unknown>;
  forbidden: ReadonlySet<object> | null;
  trail: (string | number)[];
}

/** 收尾校验的遍历状态：seen 同时承担防无限递归与共享对象去重。 */
interface EndState {
  seen: Set<object>;
  trail: (string | number)[];
}

/**
 * 单个节点的类型规则，返回需要继续遍历的容器（数组或普通对象），基本值返回 null。
 * 抽出来让两种模式共享规则，避免两份实现漂移。
 */
const checkNode = (
  value: unknown,
  trail: (string | number)[]
): object | null => {
  const type = typeof value;
  if (type === 'string' || type === 'boolean' || value === null) return null;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) fail(trail, 'non-finite number');
    return null;
  }
  if (type !== 'object') fail(trail, type + ' is not a JSON value');
  const object = value as object;
  if (Array.isArray(object)) {
    if (getProto(object) !== ARRAY_PROTO) fail(trail, 'array subclass');
    return object;
  }
  const proto = getProto(object);
  if (proto !== OBJECT_PROTO && proto !== null)
    fail(trail, 'non-plain object (' + (object.constructor?.name ?? 'unknown') + ')');
  return object;
};

/**
 * 逐个子成员调用 visit(child, state)；visit 是静态函数、状态显式传入，遍历时不为每个容器分配闭包。
 * out 不为 null 时（copy 模式）把 visit 的返回值写入同位置，构造副本；其余模式传 null。
 * 每个容器先拒绝 Symbol 键（JSON.stringify 会静默丢弃它们）；数组检查空洞，对象检查保留键与
 * 访问器属性。Symbol 检查每个容器分配一个通常为空的数组，数组容器只查一次，不随元素数增长。
 * for...in 只枚举可枚举字符串键，与 JSON.stringify 的输出范围一致；没有自有描述符的键来自
 * 原型链，与 stringify 一样跳过。数组副本用 push 构造，保持紧凑元素布局。
 */
const forEachChild = <S extends { trail: (string | number)[] }>(
  container: object,
  state: S,
  visit: (child: unknown, state: S) => unknown,
  out: unknown[] | Record<string, unknown> | null
): void => {
  const trail = state.trail;
  if (getSymbols(container).length > 0) fail(trail, 'symbol-keyed property');
  if (Array.isArray(container)) {
    for (let index = 0; index < container.length; index++) {
      trail.push(index);
      if (!(index in container)) fail(trail, 'sparse array hole');
      const result = visit(container[index], state);
      if (out !== null) (out as unknown[]).push(result);
      trail.pop();
    }
    return;
  }
  for (const key in container) {
    const descriptor = getDescriptor(container, key);
    if (descriptor === undefined) continue; // 原型链上的可枚举扩展，不是分区数据
    trail.push(key);
    if (isReservedKey(key)) fail(trail, 'reserved key');
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      fail(trail, 'accessor property');
    const result = visit(descriptor.value, state);
    if (out !== null) (out as Record<string, unknown>)[key] = result;
    trail.pop();
  }
};

function visitPublish(value: unknown, state: PublishState): void {
  const container = checkNode(value, state.trail);
  if (container === null || state.done.has(container)) return;
  if (state.ancestors.has(container)) fail(state.trail, 'circular reference');
  state.ancestors.add(container);
  forEachChild(container, state, visitPublish, null);
  state.ancestors.delete(container);
  state.done.add(container);
}

/** 校验并复制：基本值原样返回，容器返回新构造的副本。副本在子树完成后才登记到 copies。 */
function visitCopy(value: unknown, state: CopyState): unknown {
  const container = checkNode(value, state.trail);
  if (container === null) return value;
  const existing = state.copies.get(container);
  if (existing !== undefined) return existing;
  if (state.forbidden?.has(container))
    fail(state.trail, 'references an ancestor of the write target');
  if (state.ancestors.has(container)) fail(state.trail, 'circular reference');
  state.ancestors.add(container);
  const copy: unknown[] | Record<string, unknown> = Array.isArray(container) ? [] : {};
  forEachChild(container, state, visitCopy, copy);
  state.ancestors.delete(container);
  state.copies.set(container, copy);
  return copy;
}

function visitEnd(value: unknown, state: EndState): void {
  const container = checkNode(value, state.trail);
  if (container === null || state.seen.has(container)) return;
  state.seen.add(container);
  forEachChild(container, state, visitEnd, null);
}

/**
 * 发布前只校验分区根：必须是普通对象，含循环检查；不复制。
 * 用于刚从片段解析出的同版本历史数据——该对象已与调用方隔离，复制只会浪费一次遍历。
 * @throws Error 描述首个违规位置
 */
export const validatePublishRoot = (value: unknown): void => {
  if (!isPlainObject(value)) throw new JsonShapeError('$: partition root must be a plain object');
  visitPublish(value, { ancestors: new Set(), done: new Set(), trail: [] });
};

/**
 * 校验并复制任意受管 JSON 值，返回可直接挂入分区的副本（基本值原样返回）。
 * @param forbidden 写入目标的祖先容器；新值引用其中任何一个都会拒绝，保持“预检失败不修改”的
 *   既有语义。
 * @throws Error 描述首个违规位置
 */
export const copyPublish = (
  value: unknown,
  forbidden: ReadonlySet<object> | null = null
): unknown =>
  visitCopy(value, { ancestors: new Set(), copies: new Map(), forbidden, trail: [] });

/** 校验并复制分区根：必须是普通对象，用于 initialize/migrate 的返回值。 */
export const copyPublishRoot = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) throw new JsonShapeError('$: partition root must be a plain object');
  return copyPublish(value) as Record<string, unknown>;
};

/**
 * 收尾校验回调修改过的分区根：不检测循环（交给 JSON.stringify），共享对象只遍历一次。
 * 根被回调替换成非对象的情形在此拒绝——回调只能原地修改，但运行时仍需防御。
 */
export const validateForCommit = (root: unknown): void => {
  if (!isPlainObject(root)) throw new JsonShapeError('$: partition root must be a plain object');
  visitEnd(root, { seen: new Set(), trail: [] });
};
