interface RoomObject extends _HasId {}
interface Structure extends RoomObject {}
interface Source extends RoomObject {}
interface Mineral extends RoomObject {}

interface ObjectWithStore extends RoomObject {
  store: StoreDefinition;
}
