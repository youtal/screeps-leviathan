import type { createBus } from './createBus';

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
 */
type SplitEvent<T extends EventType> = T extends `${infer C}:${infer E}`
  ? [C, E]
  : never;

/**
 * 从完整事件名中提取分类。
 *
 * `SplitEvent<T>[0]` 得到的只是推导出来的字符串，因此再通过
 * `& Category` 告诉 TypeScript：这个结果一定是 EventRegistry 中的合法分类。
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
 */
export type DataByEvent<T extends EventType = EventType> = T extends EventType
  ? Merge<CategoryData<T>, EventExtraData<T>>
  : never;

/**
 * 监听器存储结构。
 *
 * 第一层 Map：
 * - key 是完整事件名，例如 `creep:spawn`
 * - value 是该事件下的订阅者集合
 *
 * 第二层 Map：
 * - key 是 subscriber 名称，用于覆盖、取消订阅和日志定位
 * - value 是实际监听器函数
 *
 * 这里监听器参数使用 `unknown`，而不是 `DataByEvent<EventType>` 或 `any`：
 * - 对外 API 会在 `subscribe` 时用泛型保证 listener 参数类型正确。
 * - 内部 Map 需要同时存储不同事件的不同 listener，无法在一个 Map 中
 *   精确保留每个 key 与 data 的对应关系。
 * - `unknown` 比 `any` 更保守，可以把“不知道具体类型”的事实限制在内部边界。
 */
export type ListenersMap = Map<EventType, Map<string, (data: unknown) => void>>;

/**
 * 全局事件作用域。
 *
 * global 作用域不绑定任何 room 或 group，因此只有一个判别字段：
 * `scope: 'global'`。
 *
 * 它用于两类场景：
 * - 发布真正的全局事件，例如系统 tick、全局统计、跨房间调度信号。
 * - 订阅全局观察者。按照当前广播原则，global 订阅者除了接收
 *   global 发布的事件，也会接收 room 发布的同类型事件。
 *
 * 注意：global 发布不会向所有 room 扇出。需要全房间广播时，应由业务层
 * 显式遍历房间并逐个发布 room 事件，避免隐藏的 CPU 成本。
 */
export type GlobalScope = {
  scope: 'global';
};

/**
 * 房间事件作用域。
 *
 * room 作用域要求同时提供：
 * - `scope: 'room'`：作为 TypeScript 判别字段。
 * - `roomName`：指定事件所属房间。
 *
 * 这种结构让调用方无法写出 `{ scope: 'room' }` 这种缺少 roomName
 * 的不完整作用域，也无法把 groupId 错传给 room 作用域。
 *
 * 按照当前广播原则：
 * - room 订阅者只接收同 room 发布的事件。
 * - room 发布会同时通知同 room 订阅者和 global 订阅者。
 * - room 发布不会通知其他 room，也不会通知任何 group。
 */
export type RoomScope = {
  scope: 'room';
  roomName: string;
};

/**
 * 分组事件作用域。
 *
 * group 作用域要求同时提供：
 * - `scope: 'group'`：作为 TypeScript 判别字段。
 * - `groupId`：指定事件所属逻辑分组。
 *
 * group 通常用于任务组、编队、临时流程、跨房间但不应暴露给全局监听流的
 * 逻辑频道。它与 room/global 不存在默认联动。
 *
 * 按照当前广播原则：
 * - group 订阅者只接收同 groupId 发布的事件。
 * - group 发布不会通知 global 订阅者。
 * - group 发布也不会通知任何 room 订阅者。
 */
export type GroupScope = {
  scope: 'group';
  groupId: string;
};

/**
 * EventBus 对外统一使用的作用域描述。
 *
 * 它是一个 discriminated union（判别联合）：
 * - 当 `scope` 是 `'global'` 时，不允许也不需要其他定位字段。
 * - 当 `scope` 是 `'room'` 时，必须携带 `roomName`。
 * - 当 `scope` 是 `'group'` 时，必须携带 `groupId`。
 *
 * 统一作用域参数让 subscribe/publish/unsubscribe 可以共用同一组接口，
 * 同时仍然在类型层面强制不同层级提供正确的定位信息。
 *
 * 示例：
 *
 * ```ts
 * bus.publish({ scope: 'global' }, 'creep:spawn', data);
 * bus.publish({ scope: 'room', roomName: 'W1N1' }, 'resource:low', data);
 * bus.publish({ scope: 'group', groupId: 'squad-alpha' }, 'combat:started', data);
 * ```
 */
export type EventScope = GlobalScope | RoomScope | GroupScope;

/**
 * EventBus 的全部监听器仓库。
 *
 * 当前支持三种作用域：
 * - global：全局事件，不绑定具体房间或分组。
 * - rooms：按 roomName 隔离的事件集合。
 * - group：按 groupName 隔离的事件集合。
 *
 * 注意：这个类型只描述存储能力。某个作用域是否已经暴露完整的
 * subscribe/publish/unsubscribe API，需要以 `createBus` 的返回值为准。
 */
export interface ListenersStore {
  global: ListenersMap;
  rooms: Map<string, ListenersMap>;
  group: Map<string, ListenersMap>;
}

/**
 * createBus 返回对象的类型。
 *
 * 使用 `ReturnType<typeof createBus>` 可以让 Bus 类型始终跟随实现变化：
 * 当 createBus 新增、删除或调整方法签名时，使用 Bus 的模块会自动得到最新类型。
 *
 * 代价是 types.ts 需要通过 `import type` 引用 createBus。`import type`
 * 只参与类型检查，不会生成运行时代码，因此不会引入实际循环依赖。
 */
export type Bus = ReturnType<typeof createBus>;
