declare module NodeJS {
  interface Global {
    mounted: boolean;
    Memory: Memory;
  }
}

interface RoomMemory {
  center?: [number, number];
}
