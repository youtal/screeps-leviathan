interface RoomObject extends _HasId {}
interface Structure extends RoomObject {}
interface Source extends RoomObject {}
interface Mineral extends RoomObject {}
type AnyObject = RoomObject | Structure | Source | Mineral;

interface ObjectWithStore extends RoomObject {
  store: StoreDefinition;
}
