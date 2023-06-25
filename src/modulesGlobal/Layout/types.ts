//为便于储存，将每个建筑的位置信息转化为一个数字，这个数字的前0-5位代表x坐标，6-11位代表y坐标
export type LayoutRecord = Partial<
  Record<BuildableStructureConstant, number[]>
>;
declare global {
  interface RoomMemory {
    layout?: { active: boolean; record: LayoutRecord };
    levelLastCheck?: number;
  }
}
