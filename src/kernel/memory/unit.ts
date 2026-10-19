/**
 * 文件摘要：kernel.memory 的单元状态与初始化/迁移事务，供分区和实体切片共同使用。
 * 持久形式为 {version,data}；运行时持有身份、脏集合及有效性，不进入持久数据。
 * 初始化与迁移先对副本计算，校验成功后才替换 record；失败不改变旧数据或发布访问器。
 * 脏集合由模块实例创建，删除/销毁会使旧单元失效；global reset 后从记录重新创建。
 */
import type { Json, UnitSpec } from '../../contracts/memory';
import { copyJson } from './json';

export type Space = 'part' | 'rooms' | 'creeps' | 'flags';
/** 唯一写入持久文本的单元包络；版本属于单元数据，不等于根 schema。 */
export type UnitRecord = { version: number; data: Json };
/** 不持久化的单元控制块；record 与根表共享引用，encoded 仅由成功提交发布。 */
export interface Unit {
  readonly id: string;
  readonly space: Space;
  readonly owner: string;
  readonly record: UnitRecord;
  readonly dirty: Set<Unit>;
  readonly check: () => void;
  active: boolean;
  /**
   * 单元数据是否可能含有未校验的值。update 原地修改后置 true；只有 commit 校验通过或 replace 以已校验副本
   * 整体替换才清除。set 只校验写入的那一处，不能清除；校验失败的提交保留此标记，直到数据修正。
   * 加载、初始化与迁移的数据在发布前已完整校验，初始为 false。业务违反只读约定、直接修改 get 返回的引用时
   * 不会置位，这类违规不再保证在提交时被拦截（MA-05 的信任边界）。
   */
  needsValidation: boolean;
  /**
   * 最近一次已知合法的包络编码：上次成功调用平台写入口时的编码，或 update 在尚无基线时对当时数据的编码。
   * 单元校验失败被隔离时，提交沿用此编码；undefined 表示尚无编码基线（只可能出现在未经 update 的单元）。
   */
  encoded?: string;
  /** 当前是否处于隔离状态：校验失败、沿用 encoded 写出时置 true，用于每次进入隔离只告警一次；成功编码后清除。 */
  isolated: boolean;
  /** 首次成功声明的 spec 身份；异构单元共享索引，具体泛型由申请方恢复。 */
  spec?: unknown;
  /** 每单元唯一访问器；回收后即使仍有引用也会被 active 检查拒绝。 */
  accessor?: unknown;
}

/**
 * @description 检查版本号与回调形状；回调返回数据由初始化或迁移路径单独验证。
 * @template T 单元持久数据类型。
 * @param spec 待校验的版本及初始化、迁移声明。
 * @returns 无返回值；正常结束表示声明形状合法。
 * @throws {TypeError} 版本不是正安全整数，或必要回调不是函数。
 */
export const checkSpec = <T extends Json>(spec: UnitSpec<T>): void => {
  if (!Number.isSafeInteger(spec.version) || spec.version < 1
    || typeof spec.initialize !== 'function' || typeof spec.migrate !== 'function') throw new TypeError('单元声明非法');
};
/**
 * @description 检查模块与单元生命周期，防止旧能力操作已回收的记录。
 * @param unit 待访问的运行时单元。
 * @returns 无返回值；正常结束表示可以访问。
 * @throws {Error} 模块不可用、提交重入、加载失败或单元已失效。
 */
export const assertUnit = (unit: Unit): void => {
  unit.check();
  if (!unit.active) throw new Error('访问器已失效');
};
/**
 * @description 加入脏集合，Set 保证重复标脏不会重复排队。
 * @param unit 已由调用方确认有效的单元。
 * @returns 无返回值；修改所属脏集合。
 */
export const touch = (unit: Unit): void => { unit.dirty.add(unit); };

/**
 * @description 计算并复制初始数据，成功后才返回包络，由调用方登记到根表。
 * @template T 单元持久数据类型。
 * @param spec 初始化声明，必须提供合法正整数版本。
 * @returns 包含版本与隔离副本的新单元包络。
 * @throws {TypeError} 声明或初始数据不合法。
 * @throws {*} initialize 回调抛出的异常原样传播，不登记半初始化记录。
 */
export const initializeUnit = <T extends Json>(spec: UnitSpec<T>): UnitRecord => {
  checkSpec(spec);
  return { version: spec.version, data: copyJson(spec.initialize()) };
};

/**
 * @description 访问或后台扫描时按声明惰性迁移，只有成功后才记住 spec 身份并允许发布访问器。
 * 传入迁移的副本隔离旧数据；返回值再复制，防止迁移函数保留可修改的存储引用。
 * 回调或校验失败时原包络不变，声明也未绑定，下次访问可以重试。
 * @template T 目标版本的单元数据类型。
 * @param unit 已加载或刚初始化的运行时单元。
 * @param spec 本次声明；已绑定的单元要求同一 spec 对象。
 * @returns 无返回值；迁移成功时更新包络并标脏。
 * @throws {Error} 单元不可用、声明冲突或迁移返回非法 JSON。
 * @throws {*} migrate 回调抛出的异常原样传播，保留旧包络。
 */
export const prepareUnit = <T extends Json>(unit: Unit, spec: UnitSpec<T>): void => {
  assertUnit(unit);
  checkSpec(spec);
  if (unit.spec && unit.spec !== spec) throw new Error('同一单元重复声明了不同 spec');
  if (unit.record.version !== spec.version) {
    const next = copyJson(spec.migrate(copyJson(unit.record.data), unit.record.version));
    unit.record.data = next;
    unit.record.version = spec.version;
    touch(unit);
  }
  unit.spec = spec;
};
