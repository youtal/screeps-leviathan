import { log, Color, getNearPos } from "@/utils";
import { profile } from "@/modulesGlobal/Profiler";
import { LayoutRecord } from "./types";
import { staticLayout, controllerLevelStructures } from "./staticLayout";
import { visStructure } from "@/modulesGlobal/roomVisiualPlus";

const prefix = "Layout";
const createLog = (content: string, color = Color.Blue, notify = false) => {
  return log(prefix, content, color, notify);
};

const variableAmountStructures = [
  STRUCTURE_EXTENSION,
  STRUCTURE_ROAD,
  STRUCTURE_LINK,
];

//这个系数用于在计算布局中心的cost时，考虑中心点距离坐标[25,25]的距离的权重
//系数越大，越倾向于选择距离坐标[25,25]越近的中心点
const CENTRAL_COEFFICIENT = 1;

//布局的正方形半径，布局的大小为(2*LAYOUT_RADIUS+1)*(2*LAYOUT_RADIUS+1)
const LAYOUT_RADIUS = 5;

@profile
class Layout {
  //此变量用于规划路径时使用
  private _PathFinderMatrix: CostMatrix;
  private _roomName: string;
  private _room: Room;
  private _terrain: RoomTerrain;
  //记录了布局区域的8个方向的出口坐标
  private _layoutExit: RoomPosition[];
  //此变量用于规划中心点时使用,键为中心点y*50+x,
  //值为中心点的cost,cost同时考虑沼泽地形对道路的影响和中线点距离坐标[25,25]的距离
  //中心点的cost越小,越适合作为中心点
  private _centerCost: Record<number, number>;
  private _centerPos: RoomPosition;
  //记录了采集souce时的工作位置
  private _sourceWorkPos: RoomPosition[];
  private _layoutRecord: LayoutRecord;
  //已规划了建筑或其他作用的位置
  //private _usdePos: RoomPosition[];
  //在使用滑窗进行布局时，若滑窗以中心y*50+x为索引，此数组中的元素为true，则会跳过此滑窗
  private _skipIdx: boolean[];
  //记录了当进行registerSkipZone操作时，整个skip区域index相对该区域中心点的偏移量，用于加速registerSkipZone操作
  private _skipZoneOffset: number[];

  constructor(roomName: string) {
    const room = Game.rooms[roomName];
    if (!room) {
      createLog(`房间${roomName}不可见，无法计算布局`, Color.Yellow);
      return;
    }
    this._roomName = roomName;
    this._room = room;
    this._terrain = new Room.Terrain(roomName);
    this._PathFinderMatrix = new PathFinder.CostMatrix();
    this.clear();
    createLog(`房间${roomName}布局器初始化完成`);
  }

  public clear() {
    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 50; y++) {
        const terrain = this._terrain.get(x, y);
        this._PathFinderMatrix.set(
          x,
          y,
          terrain === TERRAIN_MASK_WALL
            ? 255
            : terrain === TERRAIN_MASK_SWAMP
            ? //沼泽地形的cost为2，太大的话会导致路径规划时会绕远路
              2
            : 1
        );
      }
    }
    this._layoutExit = [];
    this._centerCost = {};
    this._centerPos = null;
    this._sourceWorkPos = [];
    this._layoutRecord = {};
    //this._usdePos = [];
    this._skipIdx = new Array(2500).fill(false);
    this._skipZoneOffset = new Array<number>(
      (2 * LAYOUT_RADIUS + 1) * (2 * LAYOUT_RADIUS + 1)
    );
    for (let dx = -LAYOUT_RADIUS; dx <= LAYOUT_RADIUS; dx++) {
      for (let dy = -LAYOUT_RADIUS; dy <= LAYOUT_RADIUS; dy++) {
        const index =
          (dy + LAYOUT_RADIUS) * (2 * LAYOUT_RADIUS + 1) + dx + LAYOUT_RADIUS;
        this._skipZoneOffset[index] = dy * 50 + dx;
      }
    }
    delete this._room.memory.layout;
    delete this._room.memory.center;
  }

  private _registerSkipZone(idx: number, followOnly = false) {
    // 如果followOnly为true，将_skipZoneOffset截取后半段
    const offset = followOnly
      ? this._skipZoneOffset.slice(((2 * LAYOUT_RADIUS + 1) ** 2 - 1) / 2)
      : this._skipZoneOffset;
    offset.forEach((offset) => {
      this._skipIdx[idx + offset] = true;
    });
  }

  private _planSource() {
    const sources = this._room.source;
    if (!sources) {
      createLog(`房间${this._roomName}没有发现source`, Color.Red);
      return;
    }
    sources.forEach((source) => {
      const availablePos = getNearPos(source.pos).filter((pos) => {
        return this._terrain.get(pos.x, pos.y) !== TERRAIN_MASK_WALL;
      });
      if (availablePos.length === 0) {
        createLog(
          `房间${this._roomName}的source${source.id}周围没有可用的位置`,
          Color.Red
        );
        return;
      }
      this._sourceWorkPos.push(
        availablePos.reduce((pre, cur) => {
          const curAvailablePos = getNearPos(cur).filter((pos) => {
            return this._terrain.get(pos.x, pos.y) !== TERRAIN_MASK_WALL;
          });
          const preAvailablePos = getNearPos(pre).filter((pos) => {
            return this._terrain.get(pos.x, pos.y) !== TERRAIN_MASK_WALL;
          });
          return curAvailablePos.length > preAvailablePos.length ? cur : pre;
        })
      );
    });
    this._sourceWorkPos.forEach((pos) => {
      //将该工作位置的四个角的位置注册为skip区域，尽量减少重复注册
      [-49, -51, 49, 51].forEach((offset) => {
        this._registerSkipZone(pos.y * 50 + pos.x + offset);
      });
    });
  }

  private _calcCenterCost(x: number, y: number): number {
    let cost = 0;
    staticLayout[STRUCTURE_ROAD].forEach(([dx, dy]) => {
      cost += this._terrain.get(x + dx, y + dy) === TERRAIN_MASK_SWAMP ? 1 : 0;
    });
    //考虑布局中心尽量与房间中心靠近，距离越远，代价越高
    cost += Math.sqrt((x - 25) ** 2 + (y - 25) ** 2) * CENTRAL_COEFFICIENT;
    return cost;
  }

  /**
   *
   * @param idx 待检验的中心点的index
   * @returns true表示该中心点不可用，false表示该中心点可用
   */
  private _checkIdx(idx: number): boolean {
    const [x, y] = [idx % 50, Math.floor(idx / 50)];
    for (let dx = -LAYOUT_RADIUS; dx <= LAYOUT_RADIUS; dx++) {
      for (let dy = -LAYOUT_RADIUS; dy <= LAYOUT_RADIUS; dy++) {
        const terrain = this._terrain.get(x + dx, y + dy);
        if (terrain === TERRAIN_MASK_WALL) {
          this._registerSkipZone(x + dx + (y + dy) * 50);
          return true;
        }
      }
    }
    return false;
  }

  private _slideCheck(): boolean {
    //从6开始，因为0-5和45-49都不可能是中心点
    for (let x = 6; x < 44; x++) {
      for (let y = 6; y < 44; y++) {
        const idx = y * 50 + x;
        if (this._skipIdx[idx]) continue;
        if (this._terrain.get(x, y) === TERRAIN_MASK_WALL) {
          this._registerSkipZone(idx, true);
          continue;
        }
        if (this._checkIdx(idx)) continue;
        //如果该中心点可用，计算其代价
        this._centerCost[idx] = this._calcCenterCost(x, y);
      }
    }
    if (Object.keys(this._centerCost).length === 0) {
      createLog(`房间${this._roomName}没有可用的中心点`, Color.Yellow);
      return true;
    }
    return false;
  }

  private _pickCenter() {
    const pickedIdx = Object.keys(this._centerCost).reduce((pre, cur) => {
      return this._centerCost[pre] < this._centerCost[cur] ? pre : cur;
    });
    this._centerPos = new RoomPosition(
      Number(pickedIdx) % 50,
      Math.floor(Number(pickedIdx) / 50),
      this._roomName
    );
    //计算对应中点的八个方向的出口
    const offset = [-LAYOUT_RADIUS, 0, LAYOUT_RADIUS];
    for (let dx of offset) {
      for (let dy of offset) {
        if (dx === 0 && dy === 0) continue;
        this._layoutExit.push(
          new RoomPosition(
            this._centerPos.x + dx,
            this._centerPos.y + dy,
            this._roomName
          )
        );
      }
    }
  }

  private _recordStructure(
    structureType: BuildableStructureConstant,
    pos: RoomPosition,
    unshift = false
  ) {
    if (!this._layoutRecord[structureType])
      this._layoutRecord[structureType] = [];
    if (unshift) {
      this._layoutRecord[structureType].unshift(pos.x | (pos.y << 6));
    } else this._layoutRecord[structureType].push(pos.x | (pos.y << 6));
  }

  private _planRoad() {
    //const roadPos: RoomPosition[] = [];
    const mtrix = this._PathFinderMatrix.clone();
    //将source工作位置到布局区域出口的道路规划出来,同时规划workPos周围的link和extension
    this._sourceWorkPos.forEach((pos) => {
      //使用PathFinder.search规划source工作位置到布局区域出口的道路
      const { path } = PathFinder.search(pos, this._layoutExit, {
        roomCallback() {
          return mtrix;
        },
      });
      //将道路位置记录下来
      path.forEach((pos) => {
        this._recordStructure(STRUCTURE_ROAD, pos);
      });
      //将当前workPos对应的CostMatrix设为不可用，避免后续规划道路时穿过该位置
      mtrix.set(pos.x, pos.y, 255);
      //得到workPos周围除了墙和道路以外的可用位置
      const restPos = getNearPos(pos).filter((pos) => {
        return (
          this._terrain.get(pos.x, pos.y) !== TERRAIN_MASK_WALL &&
          !pos.isEqualTo(path[0])
        );
      });
      //没有剩余位置，无法继续规划link或extension，直接返回
      if (restPos.length === 0) return;
      //将剩余位置对应的CostMatrix设为不可用，避免后续规划道路时穿过该位置
      restPos.forEach((pos) => {
        mtrix.set(pos.x, pos.y, 255);
      });
      //取出一个剩余位置，规划link
      this._recordStructure(STRUCTURE_LINK, restPos.pop());
      //剩余全部位置规划extension
      restPos.forEach((pos) => {
        this._recordStructure(STRUCTURE_EXTENSION, pos, true);
      });
    });

    //规划布局出口至controller的道路
    const { path: controllerPath } = PathFinder.search(
      this._room.controller.pos,
      this._layoutExit,
      {
        roomCallback() {
          return mtrix;
        },
      }
    );
    controllerPath.forEach((pos) => {
      this._recordStructure(STRUCTURE_ROAD, pos);
    });

    //规划布局出口至Mineral的道路
    //这条道路应当优化为controller等级达到6级后再规划，因为Mineral6级前是不可用的，但我还没想好怎么做
    const { path: mineralPath } = PathFinder.search(
      this._room.mineral.pos,
      this._layoutExit,
      {
        roomCallback() {
          return mtrix;
        },
      }
    );
    mineralPath.forEach((pos) => {
      this._recordStructure(STRUCTURE_ROAD, pos);
    });

    //规划extractor
    this._recordStructure(STRUCTURE_EXTRACTOR, this._room.mineral.pos);
  }

  public plan(): boolean {
    createLog(`开始规划房间${this._roomName}的布局`, Color.Green);
    this._planSource();
    if (this._slideCheck()) {
      createLog(`房间${this._roomName}的布局规划失败`, Color.Red);
      return false;
    }
    this._pickCenter();
    const { x: keyX, y: keyY } = this._centerPos;
    Object.keys(staticLayout).forEach((key) => {
      this._layoutRecord[key] = staticLayout[key].map(([x, y]) => {
        const [realX, realY] = [x + keyX, y + keyY];
        //数组成员为数字，0-5位记录x,6-11位记录y
        return realX | (realY << 6);
      });
    });

    this._planRoad();
    this._room.memory.layout = { active: true, record: this._layoutRecord };
    this._room.memory.center = [this._centerPos.x, this._centerPos.y];
    return true;
  }

  private _getLayoutRecord(): LayoutRecord {
    if (this._room.memory?.layout?.active) {
      createLog(`房间${this._roomName}使用Memory缓存中的布局`, Color.Green);
      return this._room.memory.layout.record;
    }
    if (!this.plan()) {
      Memory.rooms[this._roomName].layout = { active: true, record: null };
      return null;
    }
    return this._layoutRecord;
  }

  public getLayoutOnLevel(level?: number): LayoutRecord {
    const layoutRecord = this._getLayoutRecord();
    if (!layoutRecord) return null;
    level = level || this._room.controller.level;

    //下面使用reverse配合_.defaults实现高等级的布局会覆盖低等级的布局
    const rawStructuresAmount = controllerLevelStructures
      .slice(0, level)
      .reverse();
    const structuresAmount = {};
    for (const structure of rawStructuresAmount) {
      _.defaults(structuresAmount, structure);
    }

    //对于无固定数量的建筑，取当前controller等级对应数量和布局中的数量的最小值
    for (const structureType of variableAmountStructures) {
      if (
        structuresAmount[structureType] &&
        Memory.rooms[this._roomName].layout[structureType]
      ) {
        const num = Math.min(
          structuresAmount[structureType],
          Memory.rooms[this._roomName].layout[structureType].length
        );
        structuresAmount[structureType] = num;
      }
    }

    const ret = {};
    Object.keys(structuresAmount).forEach((key) => {
      ret[key] = layoutRecord[key].slice(0, structuresAmount[key]);
    });
    return ret;
  }

  public show() {
    const curLayout = this.getLayoutOnLevel((Game.time % 8) + 1);
    if (!curLayout) return;
    ///createLog(`layout: ${JSON.stringify(curLayout, null, 2)}`);
    Object.keys(curLayout).forEach((structureType) => {
      //createLog(
      //  `${structureType}: ${JSON.stringify(curLayout[structureType], null, 2)}`
      //);
      curLayout[structureType].forEach((pos) => {
        visStructure(this._roomName, pos & 0x3f, pos >> 6, structureType);
      });
    });
  }
}

export default Layout;
