/**
 * 文件摘要：持久化访问接口（contracts 层，设计见 docs/design/contracts/README.md 第 5 节，架构设计 6.1–6.5）。
 *
 * kernel.memory 实现分区与实体切片，并通过上下文注入；模块只经由 Accessor 读写自己的存储单元。
 * 路径与值的类型由单元的数据类型推导（最多 8 段）。持久数据类型须用 type 别名声明：
 * interface 没有隐式索引签名，不满足 Json 约束。本文件只含类型声明，没有运行时代码。
 */

/** 可持久化的值。对象属性允许 undefined，以便声明可选字段；写入时值本身仍须是合法 JSON。 */
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
  /** 只读引用，不复制、不冻结；不得直接修改，否则不会标脏。 */
  get<P extends Path<T>>(path: P): DeepReadonly<ValueAt<T, P>> | undefined;
  has<P extends Path<T>>(path: P): boolean;
  keys<P extends Path<T>>(path: P): readonly string[];
  /** 写入值的副本；中间容器缺失时报错，create 为 true 时自动创建普通对象；数组不自动扩容。 */
  set<P extends Path<T>>(path: P, value: ValueAt<T, P>, opts?: { readonly create?: boolean }): void;
  /** 回调内允许原地修改，标脏所在单元；回调抛错不回滚。 */
  update<P extends Path<T>>(path: P, fn: (draft: ValueAt<T, P>) => void): void;
  /** 删除成功才标脏。 */
  delete<P extends Path<T>>(path: P): boolean;
  /** 整个单元的只读引用。 */
  root(): DeepReadonly<T>;
  /** 整体替换整个单元，写入值的副本。 */
  replace(value: T): void;
}

/** 存储单元的版本与迁移声明。initialize 与 migrate 都是只依赖输入的确定性函数。 */
export interface UnitSpec<T extends Json> {
  /** 正整数，变更持久结构时加 1。 */
  readonly version: number;
  /** 首次安装时生成初始数据。 */
  initialize(): T;
  /** 已存数据的版本与 version 不一致时调用；抛错则保留原数据并拒绝访问。 */
  migrate(data: Json, fromVersion: number): T;
}

/** 模块分区的申请入口。分区身份为 (owner, localId)，owner 由上下文绑定为模块 ID。 */
export interface PartitionFactory {
  /** 在 setup 中调用，每个 localId 一次。 */
  partition<T extends Json>(localId: string, spec: UnitSpec<T>): Accessor<T>;
}

/** 实体空间（room、creep 或 flag）。 */
export interface EntitySpace {
  /** 声明本模块在该空间中的切片，在 setup 中调用一次。 */
  slice<T extends Json>(spec: UnitSpec<T>): EntitySlices<T>;
}

/** 本模块在某个实体空间中的切片集合，按实体键（房间名、creep 名、flag 名）访问。 */
export interface EntitySlices<T> {
  /** 本模块对该实体的切片；首次访问时惰性初始化或迁移。返回值按实体键缓存，记录回收后失效。 */
  of(key: string): Accessor<T>;
  /** 是否已有本模块的切片，不触发初始化。 */
  has(key: string): boolean;
}
