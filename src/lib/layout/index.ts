/**
 * 文件摘要：lib.layout，布局模式：中央枢纽判定 matchHub 与 3×3 核心模板（设计见 docs/design/lib/layout.md，架构设计 7.4、9.6）。
 *
 * 所属位置：src/lib/layout/，lib 层的无状态纯函数与冻结常量。
 * 共享定义：world.hub 用 matchHub 依据实际建筑检测枢纽，planner 用 CORE_TEMPLATES 设计核心；两者都只依赖本模块，
 * 单元测试保证每种朝向的核心模板都满足 matchHub（架构 7.4 的"共享定义"）。
 * matchHub 是泛型函数：调用方传入游戏建筑对象或快照，结果中原样返回这些元素，不复制、不读取 Game。
 * 没有模块级可变状态。
 */

/** 枢纽伙伴建筑类型（架构 7.4 条件 4）。 */
export const HUB_PARTNER_TYPES = Object.freeze(['link', 'terminal', 'factory', 'powerSpawn', 'nuker'] as const);

/** 伙伴建筑类型。 */
export type HubPartnerType = (typeof HUB_PARTNER_TYPES)[number];

/** matchHub 的输入元素：只要求带有 structureType。 */
export interface HubCandidate {
  readonly structureType: string;
}

/**
 * 枢纽判定结果。
 * @template T 调用方传入的建筑元素类型。
 */
export interface HubMatch<T extends HubCandidate> {
  /** 与枢纽格相邻的 spawn，至少 1 个，按输入顺序。 */
  readonly spawns: readonly T[];
  /** 相邻的 storage。 */
  readonly storage: T;
  /** 相邻的伙伴建筑，每类取输入中的第一个。{ [伙伴类型]: 该类建筑 } */
  readonly partners: Readonly<Partial<Record<HubPartnerType, T>>>;
}

/** 核心模板中的一格：相对枢纽格的偏移与要放置的建筑。 */
export interface CoreSlot {
  readonly dx: number;
  readonly dy: number;
  readonly structure: BuildableStructureConstant;
}

/**
 * @description 类型收窄：建筑类型是否为伙伴类型。
 * @param type 建筑类型字符串。
 * @returns 是伙伴类型时为 true，此后 type 按 HubPartnerType 使用。
 */
const isPartner = (type: string): type is HubPartnerType => (HUB_PARTNER_TYPES as readonly string[]).includes(type);

/** 核心朝向：storage 位于枢纽格的上（0）、右（1）、下（2）、左（3）方，planner 使其朝向基地重心。 */
export type CoreOrientation = 0 | 1 | 2 | 3;

/**
 * @description 判定一格是否为中央枢纽（架构 7.4）：格子本身可站且没有建筑；相邻至少 1 个 spawn；相邻有 storage；
 * 另外至少相邻 1 个伙伴建筑（link、terminal、factory、powerSpawn、nuker）。
 * @template T 建筑元素类型，例如游戏的 Structure 或快照对象。
 * @param tileFree 候选格不是墙且没有建筑；由调用方依据地形与建筑判断。
 * @param adjacent 与候选格相邻（距离 1）的本方建筑；调用方负责按所有权过滤。
 * @returns 判定结果；不满足任一条件时为 null。
 * @example
 * const hub = matchHub(free, structuresAround(tile)); // world.hub 只需检查 storage 周围的 8 个候选格
 */
export const matchHub = <T extends HubCandidate>(tileFree: boolean, adjacent: readonly T[]): HubMatch<T> | null => {
  if (!tileFree) return null;
  const spawns: T[] = [];
  let storage: T | undefined;
  const partners: Partial<Record<HubPartnerType, T>> = {};
  let partnerCount = 0;
  for (let i = 0; i < adjacent.length; i += 1) {
    const s = adjacent[i];
    const type = s.structureType;
    if (type === 'spawn') spawns.push(s);
    else if (type === 'storage') storage ??= s;
    else if (isPartner(type) && partners[type] === undefined) {
      partners[type] = s;
      partnerCount += 1;
    }
  }
  if (spawns.length === 0 || storage === undefined || partnerCount === 0) return null;
  return { spawns, storage, partners };
};

/**
 * 朝向 0 的核心模板（storage 在上方，y 轴向下）：正方向顺时针依次为 storage、terminal、factory、link；
 * 斜角上方两格为 spawn（靠近 storage 一侧），右下为 powerSpawn，左下为 nuker；外圈为 5×5 去掉四角与内圈的 12 格道路。
 * 枢纽格（0, 0）不放建筑，留给中央枢纽 creep。
 */
const CORE_BASE: readonly CoreSlot[] = Object.freeze([
  { dx: 0, dy: -1, structure: 'storage' },
  { dx: 1, dy: 0, structure: 'terminal' },
  { dx: 0, dy: 1, structure: 'factory' },
  { dx: -1, dy: 0, structure: 'link' },
  { dx: -1, dy: -1, structure: 'spawn' },
  { dx: 1, dy: -1, structure: 'spawn' },
  { dx: 1, dy: 1, structure: 'powerSpawn' },
  { dx: -1, dy: 1, structure: 'nuker' },
  { dx: -1, dy: -2, structure: 'road' }, { dx: 0, dy: -2, structure: 'road' }, { dx: 1, dy: -2, structure: 'road' },
  { dx: 2, dy: -1, structure: 'road' }, { dx: 2, dy: 0, structure: 'road' }, { dx: 2, dy: 1, structure: 'road' },
  { dx: 1, dy: 2, structure: 'road' }, { dx: 0, dy: 2, structure: 'road' }, { dx: -1, dy: 2, structure: 'road' },
  { dx: -2, dy: 1, structure: 'road' }, { dx: -2, dy: 0, structure: 'road' }, { dx: -2, dy: -1, structure: 'road' },
] satisfies CoreSlot[]);

/**
 * @description 把模板绕枢纽格顺时针旋转 90° 若干次：屏幕坐标（y 向下）中 (dx, dy) → (−dy, dx)。
 * @param slots 朝向 0 的模板。
 * @param turns 旋转次数，0–3。
 * @returns 冻结的新模板，各格顺序与输入一致。
 */
const rotate = (slots: readonly CoreSlot[], turns: number): readonly CoreSlot[] =>
  Object.freeze(slots.map((slot) => {
    let { dx, dy } = slot;
    for (let t = 0; t < turns; t += 1) [dx, dy] = [-dy, dx];
    // `+ 0` 把旋转产生的 −0 规范为 0，便于比较与作为键。
    return Object.freeze({ dx: dx + 0, dy: dy + 0, structure: slot.structure });
  }));

/** 四种朝向的核心模板，下标为 CoreOrientation；每个模板 20 格（8 个核心建筑与 12 格道路），枢纽格不在其中。 */
export const CORE_TEMPLATES: readonly (readonly CoreSlot[])[] = Object.freeze([0, 1, 2, 3].map((t) => rotate(CORE_BASE, t)));
