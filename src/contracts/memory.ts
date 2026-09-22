/**
 * 文件摘要
 *
 * 模块角色：contracts 中的持久存储协议，是业务模块与 MemoryManager 之间的访问约定。
 *
 * 主要功能：声明 JSON 值、深只读视图、分区申请配置、长期有效的访问器（query/get/commit/remove）、
 * 深路径的编译期校验类型，以及宿主 begin/end/getStatus 生命周期端口。
 *
 * 实现过程：按 owner 绑定申请函数，以 localId 和选项同步取得访问器；申请成功即可在本 global 内
 * 跨 tick 直接读写，失败抛错，不存在等待句柄或可用性状态。
 *
 * 技术要点：深路径类型采用“按实参校验”而非“枚举全部路径”——编译成本只与路径长度成正比，
 * 不随业务类型的键数量指数膨胀。DeepReadonly 只提供编译期约束，运行时不冻结、不克隆。
 * 本文件只含类型，编译后不产生代码，也不执行任何持久化。
 */

/** JSON 值的静态边界；循环引用、运行时输入及容量仍须实现校验。 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 同态映射递归保留元组及可选字段；仅编译期只读，不冻结或克隆对象。 */
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

/** 深路径的单个段：字符串用于对象键，数字只用于数组/元组下标。 */
export type PathSegment = string | number;

/**
 * 路径递归的编译期预算：超过该段数的路径在类型层判为非法，需改用 commit(mutator)。
 *
 * 校验类型逐段尾递归（见 PathValue），成本与路径长度线性相关；预算只防止异常长度的
 * 字面量把检查器拖入深递归，不限制运行时——运行时路径深度没有上限。
 */
export type MaxPathDepth = 8;

/**
 * 下降一层时去掉 undefined：可选属性（`a?: X`）与可选中间层在类型上带 undefined，
 * 但路径只在该层实际存在时才有意义；运行时缺失由实现抛错，不让合法目标变成 never。
 * null 不去掉——JSON 允许 null 作为合法值，穿越 null 在运行时同样是非法路径。
 */
type Present<T> = Exclude<T, undefined>;

/**
 * 在单个类型 T 上按一个段下降，得到下一层类型；段不合法时为 never。
 *
 * - 数组/元组只接受 number 段：元组取对应下标（字面量）或元素并集（宽 number），
 *   这样 `length`、`push` 等方法名不会进入合法路径；
 * - 普通对象只接受 string 段：静态键取属性类型；带字符串索引签名的 Record 接受任意
 *   string，并在键不是已声明键时取索引签名的值类型；`Record<number, X>` 同样接受 string 段
 *   （JSON 对象键总是字符串，运行时也只接受字符串段，调用方写 `String(tick)`）；
 * - 基本值不可下降。
 * `T extends unknown ?` 让联合类型逐分支分配，保证“某一分支合法即合法”。
 */
type Step<T, S> = T extends unknown
  ? T extends readonly unknown[]
    ? S extends number
      ? number extends S
        ? T[number]
        : `${S}` extends keyof T
          ? T[`${S}` & keyof T]
          : T extends readonly [unknown, ...unknown[]]
            ? never
            : T[number]
      : never
    : T extends object
      ? S extends string
        ? S extends keyof T
          ? T[S]
          : string extends keyof T
            ? T[string & keyof T]
            : number extends keyof T
              ? T[number & keyof T]
              : never
        : never
      : never
  : never;

/**
 * 沿路径 P 从 T 下降得到目标类型；任何一段非法则整体为 never。
 *
 * P 必须是元组（字面量长度）：宽的 `(string | number)[]` 无法逐段校验，直接判为 never，
 * 避免“宽泛默认重载”让错误路径绕过检查。空元组同样非法——空路径不代表整个分区。
 * D 计数已下降的段，超过 MaxPathDepth 判为 never。
 */
type Descend<T, P extends readonly unknown[], D extends unknown[] = []> =
  D['length'] extends MaxPathDepth
    ? never
    : P extends readonly [infer S, ...infer R]
      ? R extends readonly []
        ? Step<Present<T>, S>
        : Descend<Step<Present<T>, S>, R, [...D, unknown]>
      : never;

/**
 * M 为 any 时成立：`M extends never ? true : false` 对 any 会同时取两个分支得到 boolean，
 * 对其他类型只得到 false（never 分配后为 never）。不用常见的 `0 extends 1 & M` 写法——
 * M 受 `extends object` 约束时 `1 & M` 会被化简为 never，判定恒为 false。
 */
type IsAny<M> = boolean extends (M extends never ? true : false) ? true : false;

/**
 * 路径目标的值类型（未去掉 undefined，供读取与可删性判断使用）。
 *
 * `MemoryAccessor<any>` 是显式的动态入口：放弃编译期路径检查，任何非空路径都得到 any，
 * 运行时校验照常执行。它用于类型无法表达的动态结构；普通业务类型不会意外落到这里。
 */
export type PathValue<M, P extends readonly PathSegment[]> =
  IsAny<M> extends true
    ? any
    : number extends P['length']
    ? never
    : P extends readonly []
      ? never
      : Descend<M, P>;

/**
 * 路径写入接受的值：目标类型去掉 undefined（JSON 不能表达 undefined，删除请用 remove）。
 * 若路径非法则为 never，于是任何实参都无法满足，调用在编译期报错。
 */
export type PathWriteValue<M, P extends readonly PathSegment[]> = Present<
  PathValue<M, P>
>;

/** 路径合法时原样返回 P，否则 never；用于参数类型 `P & ValidPath<M, P>`。 */
export type ValidPath<M, P extends readonly PathSegment[]> = [
  PathValue<M, P>,
] extends [never]
  ? never
  : P;

/** 路径去掉最后一段，得到父容器路径；长度 1 时为空元组。 */
type Parent<P extends readonly unknown[]> = P extends readonly [
  ...infer H,
  unknown,
]
  ? H
  : never;
type Last<P extends readonly unknown[]> = P extends readonly [
  ...unknown[],
  infer L,
]
  ? L
  : never;

/**
 * 在对象类型 T 上，键 K 是否允许删除：可选属性或字符串/数字索引签名的动态条目可以删除，
 * 静态必填属性不行（即使同时存在索引签名）；数组/元组元素不通过路径删除（避免移位或空洞）。
 * 联合类型逐分支判断，任一分支允许即允许（运行时再按实际对象检查）。
 */
/**
 * 显式声明的键（去掉 string/number 索引签名）。`as` 键重映射把索引签名映射为 never；
 * 只有这些键才需要按“是否可选”判断，其余键命中的是索引签名的动态条目。
 */
type KnownKeys<T> = keyof {
  [P in keyof T as string extends P ? never : number extends P ? never : P]: unknown;
};

type Removable<T, K> = T extends unknown
  ? T extends readonly unknown[]
    ? false
    : T extends object
      ? K extends string
        ? K extends KnownKeys<T>
          ? {} extends Pick<T, K>
            ? true
            : false
          : string extends keyof T
            ? true
            : number extends keyof T
              ? true
              : false
        : false
      : false
  : false;

/** 路径可删除时为 P，否则 never；父容器类型沿同一套 Step 规则求出。M 为 any 时不检查。 */
export type RemovablePath<M, P extends readonly PathSegment[]> = IsAny<M> extends true
  ? P
  : [
  PathValue<M, P>,
] extends [never]
  ? never
  : true extends Removable<
        Present<P['length'] extends 1 ? M : Descend<M, Parent<P>>>,
        Last<P>
      >
    ? P
    : never;

/**
 * 顶层键 K 允许删除时为 K，否则 never：按实参逐个判断，而不是把索引签名整体展开为 string——
 * 后者会让 `{ count: number; [k: string]: number }` 上的必填键 count 也被放行。M 为 any 时不检查。
 */
export type RemovableKey<M, K extends string> = IsAny<M> extends true
  ? K
  : true extends Removable<M, K>
    ? K
    : never;

/**
 * 长期访问器：申请成功后在所属 MemoryManager 的 global 生命周期内有效，跨 tick 直接使用。
 *
 * 读取返回真实对象的深只读引用，不克隆、不冻结；通过别名直接修改不会标脏，属于协议违规。
 * 所有修改都必须经 commit/remove，并且只能在宿主 begin 与 end 之间调用。
 * 修改只表示 heap 已接受，持久化在本 tick end 统一提交。
 */
export interface MemoryAccessor<M extends object> {
  /** 整个分区的深只读引用。 */
  query(): DeepReadonly<M>;

  /** 顶层键读取；键缺失返回 undefined，不按点号拆分键名。 */
  get<K extends keyof M & string>(key: K): DeepReadonly<M[K]> | undefined;
  /**
   * 深路径读取；中间层或目标缺失返回 undefined，穿越基本值或容器类型不匹配时抛错。
   * `const P` 让字面量数组实参直接推导为只读元组，无需调用方写 `as const`；
   * NoInfer 让 P 只从实参本身推导，校验类型只负责把非法路径收窄为 never。
   */
  get<const P extends readonly PathSegment[]>(
    path: P & NoInfer<ValidPath<M, P>>
  ): DeepReadonly<PathValue<M, P>> | undefined;

  /**
   * 回调修改：先标脏（并要求收尾完整校验），再同步调用回调并返回其结果。
   * 回调必须同步、不得重入本分区修改或宿主生命周期；抛错不回滚，已做修改与脏状态保留。
   */
  commit<R>(mutator: (memory: M) => R): R;
  /** 顶层键赋值：值必须是该键的完整类型（不含 undefined）；预检成功后标脏写入。 */
  commit<K extends keyof M & string>(key: K, value: Exclude<M[K], undefined>): void;
  /** 深路径赋值：所有中间容器必须已经存在；预检失败不修改数据也不标脏。 */
  commit<const P extends readonly PathSegment[]>(
    path: P & NoInfer<ValidPath<M, P>>,
    value: PathWriteValue<M, P>
  ): void;

  /** 删除顶层可选/动态键；删除成功返回 true，目标不存在返回 false 且不标脏。 */
  remove<const K extends string>(key: K & NoInfer<RemovableKey<M, K>>): boolean;
  /** 删除深路径的对象属性；数组元素不通过路径删除，缺失的中间层返回 false。 */
  remove<const P extends readonly PathSegment[]>(
    path: P & NoInfer<RemovablePath<M, P>>
  ): boolean;
}

/**
 * 申请配置：只描述数据版本与首次安装/迁移方式，不含提交层级、间隔或存储优先级——
 * 所有脏分区统一在本 tick end 提交。
 *
 * initialize/migrate 按函数引用参与“重复申请是否同一声明”的判断，调用方应把它们
 * 声明在模块或稳定实例作用域，避免停用再启用、setup 重试时因新闭包被判为冲突。
 */
export interface MemoryApplicationOptions<M extends object> {
  /** 正整数，表示模块 payload 的版本。 */
  version: number;
  /** 确认不存在历史分区时同步调用，返回首次安装的分区对象。 */
  initialize(): M;
  /** 已存储版本与 version 不同时同步调用；memory 是与历史记录隔离的副本。 */
  migrate?(memory: unknown, fromVersion: number): M;
}

/**
 * 由装配方绑定稳定 owner（pluginId 或模块名）后的申请入口；localId 由模块保证稳定。
 * 成功同步返回访问器；配置错误、装载故障、初始化/迁移失败都直接抛错。
 */
export type ApplyMemoryAccessor = <M extends object>(
  localId: string,
  options: MemoryApplicationOptions<M>
) => MemoryAccessor<M>;

/**
 * 宿主驱动的 Memory 生命周期端口。
 *
 * 由 MemoryManager 实现，Runtime 组装，Framework 在 tick 边界调用：`begin` 在插件 setup
 * 与业务钩子之前同步装载存储（首次）并打开本 tick 的写入阶段；`end` 在插件收尾之后
 * 提交全部脏分区。构造与 `bind` 不产生存储副作用。
 */
export interface MemoryHost {
  /**
   * 最小宿主诊断，查询时生成快照：loadError 为装载故障（本 global 锁定，不写回），
   * rawWriteError 为最近一次整串提交失败原因（成功后清空）。实现可返回更多字段。
   */
  getStatus(): { loadError: string | null; rawWriteError: string | null };
  /** 装载失败时抛错；同 tick 重复调用不重复装载，倒退 tick 与同步重入拒绝。 */
  begin(tick: number): void;
  /** 提交全部脏分区；提交失败只记录诊断，不抛出。 */
  end(tick: number): void;
  bind(owner: string): ApplyMemoryAccessor;
}
