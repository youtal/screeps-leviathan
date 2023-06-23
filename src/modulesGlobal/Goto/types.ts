export interface PATH_CACHE_UNIT {
  path: number[];
  roomNames: string[];
  isSingelRoom: boolean;
  incomplete: boolean;
  generateTime: number;
  used: number;
  end: RoomPosition;
}

export type PATH_CACHE = Record<string, PATH_CACHE_UNIT>;

export interface CREEP_PATH_CACHE_UNIT extends PATH_CACHE_UNIT {
  idx: number;
  routekey: string;
}

export type CREEP_PATH_CACHE = Record<string, CREEP_PATH_CACHE_UNIT>;

export interface moveOption {
  //寻路时忽略creep
  ignoreCreeps?: boolean;
  //忽略沼泽
  ignoreSwap?: boolean;
  //忽略路
  ignoreRoads?: boolean;
  //禁用对穿
  disableCross?: boolean;
  //画出路径
  showPath?: boolean;
  //显示下一tic计划移动的位置
  showNextPos?: boolean;
  //到目标附近的范围
  range?: number;
  //最多寻路房间
  maxRooms?: number;
  //最大寻路消耗
  maxOps?: number;
  //是否跨shard移动
  crossShard?: boolean;
  //临时路径，为真时，此次寻路不会被缓存
  tmpPath?: boolean;
  //调试模式
  debug?: boolean;
  //是否检查全局缓存
  //路径检查错误，需要进行递归调用goTo时，应当设为true，防止无限递归
  globalCacheCheck?: boolean;
  veryfyRecursionTimes?: number;
}

declare global {
  interface Memory {
    avoidRooms: string[];
    avoidExits: Record<string, string[]>;
  }

  interface Creep {
    goto(
      target: RoomPosition | { pos: RoomPosition },
      opt?: moveOption
    ): number;
  }
}
