/**
 * 文件摘要：kernel.memory 的 Accessor 契约实现；输入有效单元，返回稳定的读写能力对象。
 * get/root 返回只读类型的原引用，热路径不复制或冻结；set/replace 复制调用方数据。
 * update 在执行回调前标脏，抛错仍保留修改，commit 统一校验；标量替换使用 set/replace。
 * 每单元缓存一个访问器，删除/模块销毁后所有方法均拒绝访问；无模块级状态。
 */
import type { Accessor, Json, PathSegment } from '@/contracts/memory';
import { copyJson, isObject } from './json';
import { checkPath, deleteAt, getAt, hasAt, setAt } from './path';
import { assertUnit, touch, type Unit } from './unit';

/**
 * @description 申请方先 prepareUnit，再按其 spec 对应的 T 取得能力；缓存命中不会重新分配闭包。
 * 每次操作读取 unit.record.data，而非捕获旧根，因而 replace 后同一访问器仍指向新数据。
 * @template T 已声明单元的数据类型。
 * @param unit 已完成版本准备的运行时单元。
 * @returns 该单元唯一的 Accessor；每个方法调用时仍检查单元有效性。
 */
export const accessorFor = <T extends Json>(unit: Unit): Accessor<T> => {
  if (unit.accessor) return unit.accessor as Accessor<T>;
  /**
   * @description 先检查单元有效性，再校验完整路径，避免缺失分支绕过危险键检查。
   * @param path 本次操作使用的路径。
   * @returns 无返回值；正常结束表示单元与路径形状可用。
   * @throws {Error} 生命周期不允许访问，或路径形状不合法。
   */
  const checked = (path: readonly PathSegment[]): void => { assertUnit(unit); checkPath(path); };
  // 运行时只需要 Json；对外的路径和值关联已由 contracts 的泛型约束保证。
  const accessor = {
    /**
     * @description 读取单元字段，不复制或冻结；返回的对象引用只能用于读取。
     * @param path 1–8 段字段路径。
     * @returns 目标值的原引用或标量；路径缺失时为 undefined。
     * @throws {Error} 单元不可用或路径不合法。
     */
    get(path: readonly PathSegment[]) { checked(path); return getAt(unit.record.data, path); },
    /**
     * @description 判断目标自有字段是否存在，不判断其值能否持久化。
     * update 后暂存的显式 undefined 字段仍算存在，但 commit 会拒绝该非法值。
     * @param path 待检查的字段路径。
     * @returns 字段存在时为 true，否则为 false。
     * @throws {Error} 单元不可用或路径不合法。
     */
    has(path: readonly PathSegment[]) { checked(path); return hasAt(unit.record.data, path); },
    /**
     * @description 枚举目标容器的自有可枚举键，数组下标以字符串返回。
     * @param path 目标容器路径。
     * @returns 新建键数组；目标缺失时为空数组。
     * @throws {Error} 单元不可用、路径不合法或目标是标量。
     */
    keys(path: readonly PathSegment[]) {
      // 缺失值视为空集合；标量是调用错误。数组沿用 Object.keys，返回字符串形式的下标。
      checked(path);
      const value = getAt(unit.record.data, path);
      if (value === undefined) return [];
      if (!Array.isArray(value) && !isObject(value)) throw new TypeError('keys 目标不是容器');
      return Object.keys(value);
    },
    /**
     * @description 复制输入后写入字段并标脏；失败时不发布新值。
     * @param path 写入路径。
     * @param value 待校验并复制的 JSON 值。
     * @param opts 写入选项。
     * @param opts.create 是否补齐缺失的普通对象父节点，默认 false；不扩容数组。
     * @returns 无返回值；成功时修改单元并标脏。
     * @throws {Error} 单元不可用、路径或值非法，或缺失父节点无法创建。
     */
    set(path: readonly PathSegment[], value: Json, opts?: { readonly create?: boolean }) {
      // 先验证并复制，再改存储；失败时不标脏。复制成本只覆盖输入值，不复制整个单元。
      checked(path);
      const next = copyJson(value);
      setAt(unit.record.data, path, next, opts?.create === true);
      touch(unit);
    },
    /**
     * @description 先标脏再将原引用交给回调修改；异常不回滚，数据合法性由 commit 检查。
     * @param path 已存在的目标路径。
     * @param fn 同步修改目标的回调；不得在结束后保留引用继续写入。
     * @returns 无返回值；忽略回调返回值，标量替换须使用 set 或 replace。
     * @throws {Error} 单元不可用、路径非法、目标缺失或 fn 不是函数。
     * @throws {*} 回调异常原样传播，已发生的修改和脏标记保留。
     */
    update(path: readonly PathSegment[], fn: (draft: Json) => void) {
      checked(path);
      if (typeof fn !== 'function') throw new TypeError('update 需要回调');
      const value = getAt(unit.record.data, path);
      if (value === undefined) throw new Error('update 目标不存在');
      // 先标脏并标记待校验：回调可能修改一部分后抛错。这里不回滚、不复制，合法性由 commit 校验。
      // draft 是原引用，回调结束后不得保留并继续修改；标量请通过 set/replace 替换。
      // 只有 update 能让单元变为非法；尚无编码基线时先编码此刻已校验的数据，供提交隔离时沿用（MA-02）。
      // 每个单元只在 reset 或新建后的首次 update 多编码一次，平时已有基线不再编码。
      if (unit.encoded === undefined && !unit.needsValidation) unit.encoded = JSON.stringify(unit.record);
      unit.needsValidation = true;
      touch(unit);
      fn(value);
    },
    /**
     * @description 删除对象字段，仅成功删除时标脏；数组删除须使用 update/splice。
     * @param path 待删除字段路径。
     * @returns 成功删除为 true，字段缺失为 false。
     * @throws {Error} 单元不可用、路径非法或尝试删除已有数组元素。
     */
    delete(path: readonly PathSegment[]) {
      // 删除不存在的键无需编码；数组删除被路径层拒绝，避免产生 JSON 空洞。
      checked(path);
      const removed = deleteAt(unit.record.data, path);
      if (removed) touch(unit);
      return removed;
    },
    /**
     * @description 取得整个单元的只读原引用，不复制；调用方不得直接修改。
     * @returns 当前单元根数据，replace 后再次调用会返回新的根。
     * @throws {Error} 单元或模块不可用。
     */
    root() { assertUnit(unit); return unit.record.data; },
    /**
     * @description 校验并复制完整输入后替换单元根，成功后标脏。
     * @param value 替换后的完整单元数据。
     * @returns 无返回值；原有只读引用仍指向旧数据。
     * @throws {Error} 单元不可用或输入不符合 JSON 约束。
     */
    replace(value: Json) {
      // 复制完成后才替换根；整个单元均纳入下一次编码，旧只读引用不会自动指向新根。
      assertUnit(unit);
      unit.record.data = copyJson(value);
      // 整个单元已换成刚校验过的副本，此前 update 留下的待校验内容不复存在。
      unit.needsValidation = false;
      touch(unit);
    },
  };
  unit.accessor = accessor;
  // 实现统一处理 Json；双重断言恢复契约中 Path<T>/ValueAt<T,P> 的调用侧关联，未取消运行时校验。
  return accessor as unknown as Accessor<T>;
};
