/**
 * 文件摘要
 *
 * 模块角色：项目的全局类型补充，协调 Screeps 对象与泛型 ID 查询的类型关系。
 *
 * 主要功能：补充 RoomObject、Structure、Source、Mineral 的继承关系，
 * 并声明 AnyObject 和带 store 的 ObjectWithStore，供其他源码的参数和事件数据使用。
 *
 * 实现过程：通过同名 interface 声明合并，让 RoomObject 满足 _HasId 约束，
 * 再用联合类型和接口继承描述通用对象。
 *
 * 技术要点：文件不含顶层 import/export，以保持全局声明；编译后不生成运行时代码。
 * 这些声明只影响类型检查，不会给实际游戏对象添加 id 或 store 属性。
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
