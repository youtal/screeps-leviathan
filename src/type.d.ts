interface RoomObject extends _HasId {}

interface ObjectWithStore extends RoomObject {
  store: StoreDefinition;
}
