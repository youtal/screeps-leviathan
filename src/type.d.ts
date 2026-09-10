/**
 * 文件摘要：补充项目需要的 Screeps 全局类型关系与通用对象别名。
 *
 * 声明合并让 RoomObject、Structure、Source 和 Mineral 具备 `_HasId` 约束，
 * 以便环境适配器和泛型工具接受这些对象；本文件不生成运行时代码。
 *
 * 为什么必须合并：@types/screeps 的 RoomObject 只声明 prototype/effects/pos/room，
 * 而 `Id<T extends _HasId>`、`Game.getObjectById<T extends _HasId>` 都要求 T 具备
 * `id: Id<this>`。给 RoomObject 合并 `_HasId` 后，它和三个子接口自动获得 id，
 * `Id<Structure>`、`Id<Source>` 这类写法才能在模块与测试中通过类型检查。
 *
 * 本文件没有顶层 import/export，属于全局环境声明，声明会与 @types/screeps 的同名
 * interface 合并；一旦补上 `export {}` 就会退化成模块，合并随之失效。interface 合并
 * 只能追加成员、不能改写既有成员类型，因此这里不重复声明 pos、room 等字段。
 */
/** 只追加 id 约束；三个子接口重述既有继承关系，用于让合并后的成员在联合与泛型中可见。 */
interface RoomObject extends _HasId {}
interface Structure extends RoomObject {}
interface Source extends RoomObject {}
interface Mineral extends RoomObject {}
/** 需要接受“任意带 id 的地图对象”时的联合别名；后三者都继承 RoomObject，故类型上等价于 RoomObject。 */
type AnyObject = RoomObject | Structure | Source | Mineral;

/**
 * 同时具备 id 与 store 的对象视图（Creep、Storage、Terminal 等持有标准 store 的对象）。
 * eventBus 的资源类事件用它作为 from/to 的 Id 载体：`Id<T>` 只要求 T extends _HasId，
 * 这里借助 RoomObject 的合并结果满足约束，所以不需要再声明 id 字段；也正因为它只作为
 * 不透明 Id 标签使用，无需与真实对象类型的 store 声明完全一致。
 */
interface ObjectWithStore extends RoomObject {
  store: StoreDefinition;
}
