/**
 * 文件摘要
 *
 * 模块角色：contracts 中的游戏事件目录，为总线类型和事件常量提供共同依据。
 *
 * 主要功能：列出资源、creep、建筑、房间和战斗事件，并从事件名推导对应的数据结构。
 *
 * 实现过程：EventRegistry 按分类记录公共字段和具体事件字段；映射类型生成“分类:事件”名称，
 * 条件类型拆解名称并查询两部分数据，最后合并为 DataByEvent。
 *
 * 技术要点：合并前通过 Omit 去掉公共字段中的同名项，使具体事件字段能够覆盖它们；
 * 分布式条件类型保留事件联合的对应关系。全部计算发生在编译期，不建立运行时事件表。
 */
/**
 * EventBus 的事件协议注册表。
 *
 * 这个接口是整个消息总线类型系统的“单一事实来源”：
 * - 第一层 key 是事件分类（category），例如 resource、creep、structure。
 * - `categoryData` 描述该分类下所有事件共享的基础 data 结构。
 * - `events` 描述该分类下允许出现的具体事件名，以及每个具体事件额外需要的 data 字段。
 *
 * 事件最终会被表示为 `${category}:${eventName}` 格式的字符串字面量，
 * 例如 `resource:transfer`、`creep:spawn`、`structure:destroyed`。
 *
 * 因此修改此接口会同时影响三处：EventType 的合法事件名联合、DataByEvent 推导出
 * 的载荷类型，以及 constants.ts 中 `satisfies Record<string, EventType>` 的编译
 * 期校验。请按「先注册、再补常量、最后在业务里使用」的顺序维护。
 *
 * 维护规则：
 * - 普通事件如果只需要分类的通用 data，写成 `{}` 即可。
 * - 特殊事件可以声明额外字段。
 * - 特殊事件也可以声明与 `categoryData` 同名的字段，此时具体事件字段会覆盖分类字段。
 *
 * 例如 structure 分类默认要求 `structureId: Id<Structure>`，
 * `structure:destroyed` 可以在此基础上增加 `ruinId: Id<Ruin>`。
 *
 * 如果未来希望让业务模块扩展事件协议，可以利用 TypeScript 的
 * declaration merging，在其他 .d.ts 或模块文件里继续扩展此接口。
 */
export interface EventRegistry {
  /**
   * 资源类事件。
   *
   * 适合描述资源短缺、搬运、采集等行为。当前该分类默认 data 中
   * `to` 是可选字段，因为采集、低库存告警等事件不一定存在目标对象。
   */
  resource: {
    categoryData: {
      resourceType: ResourceConstant;
      amount: number;
      from: Id<ObjectWithStore>;
      to?: Id<ObjectWithStore>;
    };
    events: {
      low: {};
      transfer: {};
      harvest: {};
    };
  };
  /**
   * Creep 生命周期事件。
   *
   * 当前只用 creepName 标识目标 creep。这里没有使用 Id<Creep>，
   * 是因为 Screeps 中 creep 的稳定引用通常就是 name, 而且 creep 相关事件大多发生在 creep 刚出生或刚死去的瞬间，
   * 这时 creep 对象可能还未生成或已经被销毁，无法提供有效的 id。
   */
  creep: {
    categoryData: {
      creepName: string;
    };
    events: {
      spawn: {};
      death: {};
    };
  };
  /**
   * 建筑相关事件。
   *
   * 所有建筑事件都保留来源房间和原建筑的 `Id<Structure>`。destroyed 事件
   * 额外提供 `ruinId`，订阅者可以按需使用原建筑 id、废墟 id，或同时使用两者。
   */
  structure: {
    categoryData: {
      roomName: string;
      structureId: Id<Structure>;
    };
    events: {
      built: {};
      damaged: {};
      destroyed: {
        ruinId: Id<Ruin>;
      };
    };
  };
  /**
   * 房间状态事件。
   *
   * 这类事件以 roomName 作为唯一上下文。它们通常适合被 room 作用域
   * 或全局战略模块监听。
   */
  room: {
    categoryData: {
      roomName: string;
    };
    events: {
      claimed: {};
      scouted: {};
      levelUp: {};
      levelDown: {};
      lost: {};
    };
  };
  /**
   * 战斗事件。
   *
   * `warType` 用联合字面量限定战斗类型，避免调用方随意传入未识别的字符串。
   */
  combat: {
    categoryData: {
      roomName: string;
      warType: 'defense' | 'invasion' | 'raid';
    };
    events: {
      started: {};
      ended: {};
      victory: {};
      defeat: {};
    };
  };
}

/**
 * 所有事件分类名称的联合类型。
 *
 * `keyof EventRegistry` 可能包含 string、number、symbol 三类 key。
 * 事件名拼接只能使用字符串，因此通过 `& string` 收窄为字符串 key。
 *
 * 当前结果类似：
 * `'resource' | 'creep' | 'structure' | 'room' | 'combat'`
 */
type Category = keyof EventRegistry & string;

/**
 * 指定分类下的具体事件名联合类型。
 *
 * 例如：
 * - `EventName<'creep'>` 得到 `'spawn' | 'death'`
 * - `EventName<'resource'>` 得到 `'low' | 'transfer' | 'harvest'`
 *
 * 这里同样使用 `& string`，确保后续可以参与模板字符串类型拼接。
 */
type EventName<C extends Category> = keyof EventRegistry[C]['events'] & string;

/**
 * EventBus 对外暴露的合法事件名联合类型。
 *
 * 它通过 mapped type 遍历每一个 Category，再用模板字符串类型生成
 * `${category}:${eventName}` 格式的事件名，最后用 `[Category]`
 * 把映射对象压平成联合类型。
 *
 * 简化理解：
 *
 * ```ts
 * {
 *   creep: 'creep:spawn' | 'creep:death';
 *   room: 'room:claimed' | 'room:lost' | ...;
 *   ...
 * }[Category]
 * ```
 *
 * 最终得到所有合法事件名的联合类型。`publish` 和 `subscribe`
 * 都依赖它来禁止未注册事件。
 */
export type EventType = {
  [C in Category]: `${C}:${EventName<C>}`;
}[Category];

/**
 * 将事件名拆分为 `[category, eventName]` 的辅助类型。
 *
 * 例如：
 * - `SplitEvent<'structure:destroyed'>`
 *   得到 `['structure', 'destroyed']`
 *
 * 它只在类型层面工作，运行时不会生成任何代码。
 *
 * 模板字面量类型的推导按第一个 `:` 定位：`infer C` 取第一个 `:` 之前的部分，
 * `infer E` 取剩余全部。因此该类型依赖事件名恰好只含一个 `:` 的约定，这正是
 * `${category}:${eventName}` 协议所保证的；不满足约束的输入会让分支落到 never。
 */
type SplitEvent<T extends EventType> = T extends `${infer C}:${infer E}`
  ? [C, E]
  : never;

/**
 * 从完整事件名中提取分类。
 *
 * `SplitEvent<T>[0]` 得到的只是推导出来的字符串，因此再通过
 * `& Category` 告诉 TypeScript：这个结果一定是 EventRegistry 中的合法分类。
 *
 * 这是纯类型层面的收窄，不产生运行时断言；事件名若不是合法的
 * `${category}:${eventName}` 组合，交集会退化成 never，并在后续索引时报错。
 */
type CategoryOf<T extends EventType> = SplitEvent<T>[0] & Category;

/**
 * 从完整事件名中提取具体事件名。
 *
 * 例如：
 * - `NameOf<'resource:transfer'>` 得到 `'transfer'`
 */
type NameOf<T extends EventType> = SplitEvent<T>[1];

/**
 * 获取某个事件所属分类的默认 data 类型。
 *
 * 例如：
 * - `CategoryData<'combat:started'>`
 *   得到 `{ roomName: string; warType: 'defense' | 'invasion' | 'raid' }`
 */
type CategoryData<T extends EventType> =
  EventRegistry[CategoryOf<T>]['categoryData'];

/**
 * 获取某个具体事件额外声明的 data 类型。
 *
 * 例如：
 * - `EventExtraData<'creep:spawn'>` 得到 `{}`
 * - `EventExtraData<'structure:destroyed'>` 得到 `{ ruinId: Id<Ruin> }`
 *
 * 条件类型里的检查用于让 TypeScript 正确理解：
 * `NameOf<T>` 是当前分类 `events` 下的合法 key。
 */
type EventExtraData<T extends EventType> =
  NameOf<T> extends keyof EventRegistry[CategoryOf<T>]['events']
    ? EventRegistry[CategoryOf<T>]['events'][NameOf<T>]
    : never;

/**
 * 合并分类默认 data 和具体事件额外 data。
 *
 * 这里不用简单的 `Base & Extra`，是因为交叉类型无法自然表达“覆盖”。
 *
 * 例子：
 *
 * ```ts
 * type Base = { structureId: Id<Structure> };
 * type Extra = { structureId: Id<Structure> | Id<Ruin> };
 * ```
 *
 * 如果写 `Base & Extra`，`structureId` 会趋向两个类型的交集，
 * 很可能仍然被收窄为 `Id<Structure>`，达不到具体事件覆盖基础字段的目的。
 *
 * `Omit<Base, keyof Extra> & Extra` 的含义是：
 * 先从基础类型中删掉所有被具体事件声明过的字段，再把具体事件字段合并回来。
 */
type Merge<Base, Extra> = Omit<Base, keyof Extra> & Extra;

/**
 * 根据完整事件名推导发布/订阅时的 data 类型。
 *
 * 它是 EventBus 类型约束的核心：
 * - `DataByEvent<'resource:transfer'>` 使用 resource 的 categoryData。
 * - `DataByEvent<'structure:destroyed'>` 同时包含 roomName、structureId 和 ruinId。
 *
 * 默认泛型参数是 `EventType`，因此不传具体事件时会得到所有事件 data 的联合类型。
 *
 * `T extends EventType ? ... : never` 是分布式条件类型写法：
 * 当 T 是联合类型时，它会对联合中的每个事件分别计算 data，再合并为联合。
 *
 * 完整推导过程（以 `structure:destroyed` 为例）：
 * 1. SplitEvent 把事件名拆成 `['structure', 'destroyed']`，CategoryOf 与 NameOf
 *    分别取出分类 `'structure'` 和事件名 `'destroyed'`。
 * 2. CategoryData 索引到 structure 的 categoryData，得到
 *    `{ roomName: string; structureId: Id<Structure> }`。
 * 3. EventExtraData 的 key 检查成立，取到 `{ ruinId: Id<Ruin> }`。
 * 4. Merge 先用 `keyof Extra` 从 Base 中 Omit 掉同名字段，再并入 Extra；
 *    对 `{}` 这类没有额外字段的事件，`Omit<Base, never>` 仍是 Base 本身。
 *
 * 所以 `DataByEvent<'structure:destroyed'>` 是
 * `{ roomName; structureId; ruinId }`，而 `DataByEvent<'creep:spawn'>` 就是
 * `{ creepName: string }`。createBus 用它约束 publish 的 data 与 subscribe 的
 * listener 参数，事件名与载荷因此一一绑定，写错事件名或漏传字段都会编译失败。
 */
export type DataByEvent<T extends EventType = EventType> = T extends EventType
  ? Merge<CategoryData<T>, EventExtraData<T>>
  : never;
