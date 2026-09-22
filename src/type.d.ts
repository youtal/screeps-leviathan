/**
 * 文件摘要
 *
 * 模块角色：项目的全局类型补充，为事件载荷等处的泛型 ID 提供通用对象视图。
 *
 * 主要功能：声明 AnyObject（带 id 的常见地图对象联合）和带 store 的 ObjectWithStore，
 * 供其他源码的参数和事件数据使用。
 *
 * 实现过程：AnyObject 只由 @types/screeps 中本身带 id 的类型组成；ObjectWithStore 显式继承
 * `_HasId`，使 `Id<ObjectWithStore>` 满足约束。
 *
 * 技术要点：文件不含顶层 import/export，以保持全局声明；编译后不生成运行时代码。
 * 不对 RoomObject 追加 id 约束：旗帜（Flag）也继承 RoomObject，却没有 id，全局合并会让
 * `flag.id` 通过编译而运行时为 undefined。
 */
/** 需要接受“任意带 id 的地图对象”时的联合别名；成员在 @types/screeps 中都声明了 id。 */
type AnyObject = Structure | Source | Mineral;

/**
 * 同时具备 id 与 store 的对象视图（Creep、Storage、Terminal 等持有标准 store 的对象）。
 * eventBus 的资源类事件用它作为 from/to 的 Id 载体：`Id<T>` 要求 T extends _HasId，这里显式
 * 继承 `_HasId` 满足约束；它只作为不透明 Id 标签使用，无需与真实对象类型的 store 声明完全一致。
 */
interface ObjectWithStore extends RoomObject, _HasId {
  store: StoreDefinition;
}
