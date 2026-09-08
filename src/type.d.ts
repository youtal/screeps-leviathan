/**
 * 文件摘要：补充项目需要的 Screeps 全局类型关系与通用对象别名。
 *
 * 声明合并让 RoomObject、Structure、Source 和 Mineral 具备 `_HasId` 约束，
 * 以便环境适配器和泛型工具接受这些对象；本文件不生成运行时代码。
 */
interface RoomObject extends _HasId {}
interface Structure extends RoomObject {}
interface Source extends RoomObject {}
interface Mineral extends RoomObject {}
type AnyObject = RoomObject | Structure | Source | Mineral;

interface ObjectWithStore extends RoomObject {
  store: StoreDefinition;
}
