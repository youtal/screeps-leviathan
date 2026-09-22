/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 的受管数据校验工具，供申请发布、路径写入与收尾提交调用。
 *
 * 主要功能：判断一个值是否满足受管 JSON 约束——null、布尔、有限数字、字符串、无空洞的普通
 * 数组和普通对象；拒绝 undefined、函数、Symbol、BigInt、NaN/Infinity、Map/Set/Date 等非普通
 * 对象、自定义 toJSON、对象上的访问器属性、Symbol 键及原型相关保留键。
 *
 * 实现过程：两种遍历模式共享同一套节点规则：
 * - publish：发布前（initialize/migrate 返回值、同版本历史数据、路径写入的新值）使用祖先栈
 *   检出循环，并可传入“禁止引用集合”拒绝指向目标祖先的引用；已完成的子树记入 done 跳过，
 *   允许分区内共享子对象。
 * - end：收尾只对回调修改过的分区调用，用单个 seen 集合跳过已访问对象，既防止无限递归又
 *   避免重复遍历共享对象；不做独立环检测——循环由随后无 replacer 的 JSON.stringify 抛错。
 *
 * 技术要点：校验失败抛出带位置（如 `$.rooms["W1N1"].links[2]`）的 Error；位置由 trail 栈在
 * 出错时拼接，正常路径只做 push/pop。集合均为调用局部，调用结束即释放，不跨 tick 保存。
 * 每个对象属性读取一次属性描述符以识别访问器属性，每个容器查询一次 Symbol 键，代价约为
 * 原生 stringify 的 1.5 倍量级，因此收尾阶段只对 needsFullValidation 分区执行。
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
 * 发布前校验的遍历状态。ancestors 是当前递归路径上的对象（检出循环），done 是已完整
 * 校验的对象（共享子对象只校验一次），forbidden 是调用方指定的禁止引用对象。
 */
interface PublishState {
  ancestors: Set<object>;
  done: Set<object>;
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
 * 每个容器先拒绝 Symbol 键（JSON.stringify 会静默丢弃它们）；数组检查空洞，对象检查保留键与
 * 访问器属性。Symbol 检查每个容器分配一个通常为空的数组，数组容器只查一次，不随元素数增长。
 * for...in 只枚举可枚举字符串键，与 JSON.stringify 的输出范围一致；普通对象原型链上没有
 * 可枚举属性，因此这里得到的都是自有键（getOwnPropertyDescriptor 同时确认这一点）。
 */
const forEachChild = <S extends { trail: (string | number)[] }>(
  container: object,
  state: S,
  visit: (child: unknown, state: S) => void
): void => {
  const trail = state.trail;
  if (getSymbols(container).length > 0) fail(trail, 'symbol-keyed property');
  if (Array.isArray(container)) {
    for (let index = 0; index < container.length; index++) {
      trail.push(index);
      if (!(index in container)) fail(trail, 'sparse array hole');
      visit(container[index], state);
      trail.pop();
    }
    return;
  }
  for (const key in container) {
    trail.push(key);
    if (isReservedKey(key)) fail(trail, 'reserved key');
    const descriptor = getDescriptor(container, key);
    if (descriptor === undefined) fail(trail, 'inherited property');
    if (descriptor!.get !== undefined || descriptor!.set !== undefined)
      fail(trail, 'accessor property');
    visit(descriptor!.value, state);
    trail.pop();
  }
};

function visitPublish(value: unknown, state: PublishState): void {
  const container = checkNode(value, state.trail);
  if (container === null || state.done.has(container)) return;
  if (state.forbidden?.has(container))
    fail(state.trail, 'references an ancestor of the write target');
  if (state.ancestors.has(container)) fail(state.trail, 'circular reference');
  state.ancestors.add(container);
  forEachChild(container, state, visitPublish);
  state.ancestors.delete(container);
  state.done.add(container);
}

function visitEnd(value: unknown, state: EndState): void {
  const container = checkNode(value, state.trail);
  if (container === null || state.seen.has(container)) return;
  state.seen.add(container);
  forEachChild(container, state, visitEnd);
}

/**
 * 发布前校验任意受管 JSON 值（含循环与禁止引用检查）。
 * @param forbidden 写入目标的祖先容器；新值引用其中任何一个都会在写入后成环。
 * @throws Error 描述首个违规位置
 */
export const validatePublish = (
  value: unknown,
  forbidden: ReadonlySet<object> | null = null
): void => {
  visitPublish(value, {
    ancestors: new Set(),
    done: new Set(),
    forbidden,
    trail: [],
  });
};

/** 发布前校验分区根：必须是普通对象，其余同 validatePublish。 */
export const validatePublishRoot = (value: unknown): void => {
  if (!isPlainObject(value)) throw new JsonShapeError('$: partition root must be a plain object');
  validatePublish(value);
};

/**
 * 收尾校验回调修改过的分区根：不检测循环（交给 JSON.stringify），共享对象只遍历一次。
 * 根被回调替换成非对象的情形在此拒绝——回调只能原地修改，但运行时仍需防御。
 */
export const validateForCommit = (root: unknown): void => {
  if (!isPlainObject(root)) throw new JsonShapeError('$: partition root must be a plain object');
  visitEnd(root, { seen: new Set(), trail: [] });
};
