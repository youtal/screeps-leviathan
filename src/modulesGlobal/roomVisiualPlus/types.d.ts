type DrawableStructure =
  | STRUCTURE_FACTORY
  | STRUCTURE_EXTENSION
  | STRUCTURE_SPAWN
  | STRUCTURE_POWER_SPAWN
  | STRUCTURE_LINK
  | STRUCTURE_TERMINAL
  | STRUCTURE_LAB
  | STRUCTURE_TOWER
  | STRUCTURE_ROAD
  | STRUCTURE_RAMPART
  | STRUCTURE_WALL
  | STRUCTURE_STORAGE
  | STRUCTURE_OBSERVER
  | STRUCTURE_NUKER
  | STRUCTURE_CONTAINER
  | STRUCTURE_EXTRACTOR;

interface RoomVisual {
  speech(text: string, x: number, y: number, opts?: TextStyle): void;
  connectRoads(): void;
  animatedPosition(x: number, y: number, opts?: CircleStyle): RoomVisual;
  test(): RoomVisual;
  resource(
    type: ResourceConstant,
    x: number,
    y: number,
    size?: number
  ): RoomVisual;
  structure(
    x: number,
    y: number,
    type: DrawableStructure,
    opts?: any
  ): RoomVisual;
  _roads: Array<[number, number]>;
}
