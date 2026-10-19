/**
 * 文件摘要：持久化访问接口（contracts 层，设计见 docs/design/contracts/README.md 第 5 节，架构设计 6.1–6.5）。
 *
 * kernel.memory 实现分区与实体切片，并通过上下文注入；模块只经由 Accessor 读写自己的存储单元。
 * 路径与值的类型由单元的数据类型推导（最多 8 段）。持久数据类型须用 type 别名声明：
 * interface 没有隐式索引签名，不满足 Json 约束。本文件只含类型声明，没有运行时代码。
 */

/**
 * 可持久化数据的静态类型；对象索引中的 undefined 仅用于兼容可选字段声明。
 * 运行时字段可以缺省，但禁止显式 undefined（包括嵌套字段）；移除字段使用 delete。
 * 非 JSON 类型不静默转换；Map 须由调用方显式转换为普通对象或键值对数组。
 */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json | undefined };

/** 路径段：字符串对应对象键，非负整数对应数组下标。 */
export type PathSegment = string | number;

/** 剩余深度递减表：Depth[D] 为 D − 1（D 为 1–8），Depth[0] 保持 0。 */
type Depth = [0, 0, 1, 2, 3, 4, 5, 6, 7];

/** 由数据类型 T 推导的全部合法路径（1–8 段）。可选字段与可空值按去掉 undefined、null 后的类型继续展开。 */
export type Path<T, D extends number = 8> = [D] extends [0]
  ? never
  : T extends readonly (infer E)[]
    ? readonly [number] | readonly [number, ...Path<NonNullable<E>, Depth[D]>]
    : T extends object
      ? { [K in keyof T & string]-?: readonly [K] | readonly [K, ...Path<NonNullable<T[K]>, Depth[D]>] }[keyof T & string]
      : never;

/** 沿一个路径段前进一步得到的值类型。 */
type Step<T, H> = T extends readonly (infer E)[] ? (H extends number ? E : never) : H extends keyof T ? T[H] : never;

/** 路径 P 在数据类型 T 中指向的值类型；末段保留声明类型（可选字段含 undefined）。 */
export type ValueAt<T, P extends readonly PathSegment[]> = P extends readonly [infer H, ...infer R extends readonly PathSegment[]]
  ? R extends readonly []
    ? Step<T, H>
    : ValueAt<NonNullable<Step<T, H>>, R>
  : T;

/** 递归只读视图，用于 get 返回的引用。 */
export type DeepReadonly<T> = T extends readonly (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * 一个存储单元（分区或实体切片）的读写接口，语义见架构设计 6.3。
 * 热路径上把路径声明为模块级常量元组，避免每次调用分配新数组。
 */
export interface Accessor<T> {
  /**
   * @description 读取路径上的值，返回只读引用，不复制、不冻结；不得直接修改，否则不会标脏。
   * @template P 由单元数据类型推导的合法路径。
   * @param path 1–8 段路径。
   * @returns 目标值的只读引用；路径缺失时为 undefined。
   * @throws {Error} 单元已失效或路径非法。
   */
  get<P extends Path<T>>(path: P): DeepReadonly<ValueAt<T, P>> | undefined;
  /**
   * @description 判断路径末段的自有字段是否存在，不判断其值能否持久化。
   * @template P 由单元数据类型推导的合法路径。
   * @param path 1–8 段路径。
   * @returns 字段存在时为 true。
   * @throws {Error} 单元已失效或路径非法。
   */
  has<P extends Path<T>>(path: P): boolean;
  /**
   * @description 枚举路径指向容器的自有键，数组下标以字符串返回。
   * @template P 由单元数据类型推导的合法路径。
   * @param path 1–8 段路径。
   * @returns 键列表；目标缺失时为空数组。
   * @throws {Error} 单元已失效、路径非法或目标不是容器。
   */
  keys<P extends Path<T>>(path: P): readonly string[];
  /**
   * @description 校验并写入值的副本，标脏所在单元。
   * @template P 由单元数据类型推导的合法路径。
   * @param path 1–8 段路径。
   * @param value 合法 JSON 值，写入其副本。
   * @param opts 写入选项。
   * @param opts.create 中间容器缺失时是否自动创建普通对象，默认 false（缺失即报错）；数组不自动扩容。
   * @returns 无返回值。
   * @throws {Error} 单元已失效、路径或值非法、中间容器缺失且不允许创建。
   */
  set<P extends Path<T>>(path: P, value: ValueAt<T, P>, opts?: { readonly create?: boolean }): void;
  /**
   * @description 标脏所在单元后把目标的原引用交给回调原地修改；回调抛错不回滚，合法性在提交时校验。
   * @template P 由单元数据类型推导的合法路径。
   * @param path 指向已存在值的 1–8 段路径。
   * @param fn 同步修改目标的回调，结束后不得保留引用继续写入。
   * @returns 无返回值。
   * @throws {Error} 单元已失效、路径非法或目标不存在；回调抛出的异常原样传播。
   */
  update<P extends Path<T>>(path: P, fn: (draft: ValueAt<T, P>) => void): void;
  /**
   * @description 删除对象字段；删除成功才标脏。数组元素须在 update 中用 splice 删除。
   * @template P 由单元数据类型推导的合法路径。
   * @param path 1–8 段路径。
   * @returns 成功删除为 true，字段不存在为 false。
   * @throws {Error} 单元已失效、路径非法或尝试删除数组元素。
   */
  delete<P extends Path<T>>(path: P): boolean;
  /**
   * @description 取得整个单元的只读引用，不复制；不得直接修改。
   * @returns 单元根数据的只读引用。
   * @throws {Error} 单元已失效。
   */
  root(): DeepReadonly<T>;
  /**
   * @description 校验并以值的副本整体替换整个单元，标脏所在单元。
   * @param value 替换后的完整单元数据。
   * @returns 无返回值；此前取得的只读引用仍指向旧数据。
   * @throws {Error} 单元已失效或值非法。
   */
  replace(value: T): void;
}

/** 存储单元的版本与迁移声明。initialize 与 migrate 都是只依赖输入的确定性函数。 */
export interface UnitSpec<T extends Json> {
  /** 正整数，变更持久结构时加 1。 */
  readonly version: number;
  /**
   * @description 首次安装时生成初始数据；确定性函数，只依赖输入。
   * @returns 合法 JSON 的初始数据。
   */
  initialize(): T;
  /**
   * @description 已存数据的版本与 version 不一致时调用，把数据转换到当前版本；确定性函数，只依赖输入。
   * @param data 已存数据的副本。
   * @param fromVersion 已存数据的版本，回滚旧代码时可能高于 version。
   * @returns 当前版本的数据。
   * @throws {*} 无法迁移时抛错；原数据保留，访问器不发布。
   */
  migrate(data: Json, fromVersion: number): T;
}

/** 模块分区的申请入口。分区身份为 (owner, localId)，owner 由上下文绑定为模块 ID。 */
export interface PartitionFactory {
  /**
   * @description 申请本模块的分区，必要时初始化或迁移；在 setup 中调用，每个 localId 一次。
   * @template T 分区数据类型，须用 type 别名声明。
   * @param localId 本模块内的分区名称。
   * @param spec 版本与初始化、迁移声明；重复申请须沿用同一对象。
   * @returns 该分区的访问器。
   * @throws {Error} 名称或声明非法、声明冲突；初始化或迁移回调的异常原样传播。
   */
  partition<T extends Json>(localId: string, spec: UnitSpec<T>): Accessor<T>;
}

/** 实体空间（room、creep 或 flag）。 */
export interface EntitySpace {
  /**
   * @description 声明本模块在该空间中的切片规则，不立即遍历或迁移已有实体；在 setup 中调用一次。
   * @template T 切片数据类型，须用 type 别名声明。
   * @param spec 版本与初始化、迁移声明；重复声明须沿用同一对象。
   * @returns 按实体键访问切片的入口。
   * @throws {Error} 声明非法或与已有声明冲突。
   */
  slice<T extends Json>(spec: UnitSpec<T>): EntitySlices<T>;
}

/** 本模块在某个实体空间中的切片集合，按实体键（房间名、creep 名、flag 名）访问。 */
export interface EntitySlices<T> {
  /**
   * @description 取得本模块对该实体的切片，首次访问时惰性初始化或迁移。
   * @param key 实体键：房间名、creep 名或 flag 名。
   * @returns 该切片的访问器；按实体键缓存，记录回收后失效。
   * @throws {Error} 名称非法；初始化或迁移回调的异常原样传播。
   */
  of(key: string): Accessor<T>;
  /**
   * @description 查询是否已有本模块对该实体的切片，不触发初始化。
   * @param key 实体键：房间名、creep 名或 flag 名。
   * @returns 已有切片时为 true。
   */
  has(key: string): boolean;
}
