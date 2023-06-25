const colors = {
  gray: "#555555",
  light: "#AAAAAA",
  road: "#666", // >:D
  energy: "#FFE87B",
  power: "#F53547",
  dark: "#181818",
  outline: "#8FBB93",
  speechText: "#000000",
  speechBackground: "#2ccf3b",
};

//const speechSize = 0.5;
const speechFont = "Times New Roman";

const factoryLevelGaps = function () {
  let x = -0.08;
  let y = -0.52;
  let result = [];

  let gapAngle = 16 * (Math.PI / 180);
  let c1 = Math.cos(gapAngle);
  let s1 = Math.sin(gapAngle);

  let angle = 72 * (Math.PI / 180);
  let c2 = Math.cos(angle);
  let s2 = Math.sin(angle);

  for (let i = 0; i < 5; ++i) {
    result.push([0.0, 0.0]);
    result.push([x, y]);
    result.push([x * c1 - y * s1, x * s1 + y * c1]);
    let tmpX = x * c2 - y * s2;
    y = x * s2 + y * c2;
    x = tmpX;
  }
  return result;
};

const relPoly = function (x, y, poly) {
  return poly.map((p) => {
    p[0] += x;
    p[1] += y;
    return p;
  });
};

const StructureDrawingMap: Record<
  DrawableStructure,
  (x: number, y: number, visual: RoomVisual, opts: any) => void
> = {
  [STRUCTURE_FACTORY]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    const outline = [
      [-0.68, -0.11],
      [-0.84, -0.18],
      [-0.84, -0.32],
      [-0.44, -0.44],
      [-0.32, -0.84],
      [-0.18, -0.84],
      [-0.11, -0.68],

      [0.11, -0.68],
      [0.18, -0.84],
      [0.32, -0.84],
      [0.44, -0.44],
      [0.84, -0.32],
      [0.84, -0.18],
      [0.68, -0.11],

      [0.68, 0.11],
      [0.84, 0.18],
      [0.84, 0.32],
      [0.44, 0.44],
      [0.32, 0.84],
      [0.18, 0.84],
      [0.11, 0.68],

      [-0.11, 0.68],
      [-0.18, 0.84],
      [-0.32, 0.84],
      [-0.44, 0.44],
      [-0.84, 0.32],
      [-0.84, 0.18],
      [-0.68, 0.11],
    ];
    visual.poly(
      outline.map((p) => [p[0] + x, p[1] + y]),
      {
        fill: null,
        stroke: colors.outline,
        strokeWidth: 0.05,
        opacity: opts.opacity,
      }
    );
    // outer circle
    visual.circle(x, y, {
      radius: 0.65,
      fill: "#232323",
      strokeWidth: 0.035,
      stroke: "#140a0a",
      opacity: opts.opacity,
    });
    const spikes = [
      [-0.4, -0.1],
      [-0.8, -0.2],
      [-0.8, -0.3],
      [-0.4, -0.4],
      [-0.3, -0.8],
      [-0.2, -0.8],
      [-0.1, -0.4],

      [0.1, -0.4],
      [0.2, -0.8],
      [0.3, -0.8],
      [0.4, -0.4],
      [0.8, -0.3],
      [0.8, -0.2],
      [0.4, -0.1],

      [0.4, 0.1],
      [0.8, 0.2],
      [0.8, 0.3],
      [0.4, 0.4],
      [0.3, 0.8],
      [0.2, 0.8],
      [0.1, 0.4],

      [-0.1, 0.4],
      [-0.2, 0.8],
      [-0.3, 0.8],
      [-0.4, 0.4],
      [-0.8, 0.3],
      [-0.8, 0.2],
      [-0.4, 0.1],
    ];
    visual.poly(
      spikes.map((p) => [p[0] + x, p[1] + y]),
      {
        fill: colors.gray,
        stroke: "#140a0a",
        strokeWidth: 0.04,
        opacity: opts.opacity,
      }
    );
    // factory level circle
    visual.circle(x, y, {
      radius: 0.54,
      fill: "#302a2a",
      strokeWidth: 0.04,
      stroke: "#140a0a",
      opacity: opts.opacity,
    });
    visual.poly(
      factoryLevelGaps().map((p) => [p[0] + x, p[1] + y]),
      {
        fill: "#140a0a",
        stroke: null,
        opacity: opts.opacity,
      }
    );
    // inner black circle
    visual.circle(x, y, {
      radius: 0.42,
      fill: "#140a0a",
      opacity: opts.opacity,
    });
    visual.rect(x - 0.24, y - 0.24, 0.48, 0.48, {
      fill: "#3f3f3f",
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_EXTENSION]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      radius: 0.5,
      fill: colors.dark,
      stroke: colors.outline,
      strokeWidth: 0.05,
      opacity: opts.opacity,
    });
    visual.circle(x, y, {
      radius: 0.35,
      fill: colors.gray,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_SPAWN]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      radius: 0.65,
      fill: colors.dark,
      stroke: "#CCCCCC",
      strokeWidth: 0.1,
      opacity: opts.opacity,
    });
    visual.circle(x, y, {
      radius: 0.4,
      fill: colors.energy,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_POWER_SPAWN]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      radius: 0.65,
      fill: colors.dark,
      stroke: colors.power,
      strokeWidth: 0.1,
      opacity: opts.opacity,
    });
    visual.circle(x, y, {
      radius: 0.4,
      fill: colors.energy,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_LINK]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    let osize = 0.3;
    let isize = 0.2;
    let outer: Array<[number, number]> = [
      [0.0, -0.5],
      [0.4, 0.0],
      [0.0, 0.5],
      [-0.4, 0.0],
    ];
    let inner: Array<[number, number]> = [
      [0.0, -0.3],
      [0.25, 0.0],
      [0.0, 0.3],
      [-0.25, 0.0],
    ];
    outer = relPoly(x, y, outer);
    inner = relPoly(x, y, inner);
    outer.push(outer[0]);
    inner.push(inner[0]);
    visual.poly(outer, {
      fill: colors.dark,
      stroke: colors.outline,
      strokeWidth: 0.05,
      opacity: opts.opacity,
    });
    visual.poly(inner, {
      fill: colors.gray,
      stroke: undefined,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_TERMINAL]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    let outer: Array<[number, number]> = [
      [0.0, -0.8],
      [0.55, -0.55],
      [0.8, 0.0],
      [0.55, 0.55],
      [0.0, 0.8],
      [-0.55, 0.55],
      [-0.8, 0.0],
      [-0.55, -0.55],
    ];
    let inner: Array<[number, number]> = [
      [0.0, -0.65],
      [0.45, -0.45],
      [0.65, 0.0],
      [0.45, 0.45],
      [0.0, 0.65],
      [-0.45, 0.45],
      [-0.65, 0.0],
      [-0.45, -0.45],
    ];
    outer = relPoly(x, y, outer);
    inner = relPoly(x, y, inner);
    outer.push(outer[0]);
    inner.push(inner[0]);
    visual.poly(outer, {
      fill: colors.dark,
      stroke: colors.outline,
      strokeWidth: 0.05,
      opacity: opts.opacity,
    });
    visual.poly(inner, {
      fill: colors.light,
      stroke: undefined,
      opacity: opts.opacity,
    });
    visual.rect(x - 0.45, y - 0.45, 0.9, 0.9, {
      fill: colors.gray,
      stroke: colors.dark,
      strokeWidth: 0.1,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_LAB]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y - 0.025, {
      radius: 0.55,
      fill: colors.dark,
      stroke: colors.outline,
      strokeWidth: 0.05,
      opacity: opts.opacity,
    });
    visual.circle(x, y - 0.025, {
      radius: 0.4,
      fill: colors.gray,
      opacity: opts.opacity,
    });
    visual.rect(x - 0.45, y + 0.3, 0.9, 0.25, {
      fill: colors.dark,
      stroke: null,
      opacity: opts.opacity,
    });
    {
      let box: Array<[number, number]> = [
        [-0.45, 0.3],
        [-0.45, 0.55],
        [0.45, 0.55],
        [0.45, 0.3],
      ];
      box = relPoly(x, y, box);
      visual.poly(box, {
        stroke: colors.outline,
        strokeWidth: 0.05,
        opacity: opts.opacity,
      });
    }
  },
  [STRUCTURE_TOWER]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      radius: 0.6,
      fill: colors.dark,
      stroke: colors.outline,
      strokeWidth: 0.05,
      opacity: opts.opacity,
    });
    visual.rect(x - 0.4, y - 0.3, 0.8, 0.6, {
      fill: colors.gray,
      opacity: opts.opacity,
    });
    visual.rect(x - 0.2, y - 0.9, 0.4, 0.5, {
      fill: colors.light,
      stroke: colors.dark,
      strokeWidth: 0.07,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_ROAD]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      radius: 0.175,
      fill: colors.road,
      stroke: undefined,
      opacity: opts.opacity,
    });
    if (!visual._roads) visual._roads = [];
    visual._roads.push([x, y]);
  },
  [STRUCTURE_RAMPART]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      radius: 0.65,
      fill: "#434C43",
      stroke: "#5D735F",
      strokeWidth: 0.1,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_WALL]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      radius: 0.4,
      fill: colors.dark,
      stroke: colors.light,
      strokeWidth: 0.05,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_STORAGE]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    let outline1: Array<[number, number]> = relPoly(x, y, [
      [-0.45, -0.55],
      [0, -0.65],
      [0.45, -0.55],
      [0.55, 0],
      [0.45, 0.55],
      [0, 0.65],
      [-0.45, 0.55],
      [-0.55, 0],
      [-0.45, -0.55],
    ]);
    visual.poly(outline1, {
      stroke: colors.outline,
      strokeWidth: 0.05,
      fill: colors.dark,
      opacity: opts.opacity,
    });
    visual.rect(x - 0.35, y - 0.45, 0.7, 0.9, {
      fill: colors.energy,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_OBSERVER]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      fill: colors.dark,
      radius: 0.45,
      stroke: colors.outline,
      strokeWidth: 0.05,
      opacity: opts.opacity,
    });
    visual.circle(x + 0.225, y, {
      fill: colors.outline,
      radius: 0.2,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_NUKER]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    let outline: Array<[number, number]> = [
      [0, -1],
      [-0.47, 0.2],
      [-0.5, 0.5],
      [0.5, 0.5],
      [0.47, 0.2],
      [0, -1],
    ];
    outline = relPoly(x, y, outline);
    visual.poly(outline, {
      stroke: colors.outline,
      strokeWidth: 0.05,
      fill: colors.dark,
      opacity: opts.opacity,
    });
    let inline: Array<[number, number]> = [
      [0, -0.8],
      [-0.4, 0.2],
      [0.4, 0.2],
      [0, -0.8],
    ];
    inline = relPoly(x, y, inline);
    visual.poly(inline, {
      stroke: colors.outline,
      strokeWidth: 0.01,
      fill: colors.gray,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_CONTAINER]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.rect(x - 0.225, y - 0.3, 0.45, 0.6, {
      fill: colors.gray,
      opacity: opts.opacity,
      stroke: colors.dark,
      strokeWidth: 0.09,
    });
    visual.rect(x - 0.17, y + 0.07, 0.34, 0.2, {
      fill: colors.energy,
      opacity: opts.opacity,
    });
  },
  [STRUCTURE_EXTRACTOR]: function (
    x: number,
    y: number,
    visual: RoomVisual,
    opts: any
  ) {
    visual.circle(x, y, {
      fill: colors.outline,
      radius: 0.45,
      stroke: colors.light,
      strokeWidth: 0.05,
      opacity: opts.opacity,
    });
    visual.circle(x, y, {
      fill: colors.dark,
      radius: 0.35,
      opacity: opts.opacity,
    });
    let inline: Array<[number, number]> = [
      [0.225, -0.3],
      [0, -0.4],
      [-0.225, -0.3],
      [0, 0.4],
      [0.225, -0.3],
    ];
    inline = relPoly(x, y, inline);
    visual.poly(inline, {
      stroke: colors.light,
      strokeWidth: 0.05,
      fill: undefined,
      opacity: opts.opacity,
    });
  },
};

const drawStructure = function (
  visual: RoomVisual,
  type: DrawableStructure,
  x: number,
  y: number,
  opts = {}
): RoomVisual {
  _.defaults(opts, { opacity: 1 });
  StructureDrawingMap[type](x, y, visual, opts);
  return visual;
};

const connectRoads = function (
  visual: RoomVisual,
  ops: LineStyle = {}
): RoomVisual {
  _.defaults(ops, { opacity: 1 });
  const dirs = [
    [],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  let color = colors.road || colors.road;
  if (!visual._roads) return;
  visual._roads.forEach((r) => {
    for (let i = 1; i <= 4; i++) {
      let d = dirs[i];
      let c = [r[0] + d[0], r[1] + d[1]];
      if (_.some(visual._roads, (r) => r[0] == c[0] && r[1] == c[1])) {
        visual.line(r[0], r[1], c[0], c[1], {
          color: color,
          width: 0.35,
          opacity: ops.opacity,
        });
      }
    }
  });
  return visual;
};

const speech = function (visual, text, x, y, opts: TextStyle = {}) {
  const backgroundColor = opts.backgroundColor || colors.speechBackground;
  const textColor = opts.color || colors.speechText;
  const font = opts.font || speechFont;
  const capacity = opts.opacity || 1;

  let pointer = [
    [-0.2, -0.8],
    [0.2, -0.8],
    [0, -0.3],
  ];

  pointer = relPoly(x, y, pointer);
  pointer.push(pointer[0]);

  visual.poly(pointer, {
    fill: backgroundColor,
    stroke: backgroundColor,
    opacity: capacity,
    strokeWidth: 0.0,
  });

  visual.text(text, x, y - 1, {
    color: textColor,
    backgroundColor: backgroundColor,
    backgroundPadding: 0.1,
    opacity: capacity,
    font: font,
  });
  return visual;
};

/**
 *
 * @param visual
 * @param x
 * @param y
 * @param opts {fill: string, opacity: number, radius: number, frames: number}
 */
const animatedPosition = function (
  visual: RoomVisual,
  x: number,
  y: number,
  opts: any = {}
): RoomVisual {
  const color = opts.fill || "blue";
  const opacity = opts.opacity || 0.5;
  let radius = opts.radius || 0.75;
  const frames = opts.frames || 6;

  let angle = (((Game.time % frames) * 90) / frames) * (Math.PI / 180);
  let s = Math.sin(angle);
  let c = Math.cos(angle);

  let sizeMod = Math.abs((Game.time % frames) - frames / 2) / 10;
  radius += radius * sizeMod;

  let points: Array<[number, number]> = [
    rotate(0, -radius, s, c, x, y),
    rotate(radius, 0, s, c, x, y),
    rotate(0, radius, s, c, x, y),
    rotate(-radius, 0, s, c, x, y),
    rotate(0, -radius, s, c, x, y),
  ];

  visual.poly(points, {
    stroke: color,
    opacity: opacity,
  });
  return visual;
};

function rotate(x, y, s, c, px, py): [number, number] {
  let xDelta = x * c - y * s;
  let yDelta = x * s + y * c;
  return [px + xDelta, py + yDelta];
}

const test = function (visual: RoomVisual): RoomVisual {
  let demoPos = [25, 25];
  //visual.clear();
  drawStructure(visual, STRUCTURE_SPAWN, demoPos[0], demoPos[1]);
  drawStructure(visual, STRUCTURE_EXTENSION, demoPos[0] + 1, demoPos[1]);
  drawStructure(visual, STRUCTURE_LAB, demoPos[0] + 2, demoPos[1]);
  drawStructure(visual, STRUCTURE_TOWER, demoPos[0] + 3, demoPos[1]);
  drawStructure(visual, STRUCTURE_LINK, demoPos[0] + 4, demoPos[1]);
  drawStructure(visual, STRUCTURE_POWER_SPAWN, demoPos[0] + 5, demoPos[1]);
  drawStructure(visual, STRUCTURE_NUKER, demoPos[0] + 6, demoPos[1]);
  drawStructure(visual, STRUCTURE_OBSERVER, demoPos[0] + 7, demoPos[1]);
  drawStructure(visual, STRUCTURE_ROAD, demoPos[0] + 8, demoPos[1]);
  drawStructure(visual, STRUCTURE_WALL, demoPos[0] + 9, demoPos[1]);
  drawStructure(visual, STRUCTURE_SPAWN, demoPos[0] + 10, demoPos[1]);
  drawStructure(visual, STRUCTURE_RAMPART, demoPos[0] + 11, demoPos[1]);
  drawStructure(
    drawStructure(visual, STRUCTURE_CONTAINER, demoPos[0] + 13, demoPos[1]),
    STRUCTURE_STORAGE,
    demoPos[0] + 12,
    demoPos[1]
  );

  visual.resource(RESOURCE_ENERGY, demoPos[0] + 14, demoPos[1]);
  visual.resource(RESOURCE_POWER, demoPos[0] + 15, demoPos[1]);
  visual.resource(RESOURCE_UTRIUM, demoPos[0] + 16, demoPos[1]);
  visual.resource(
    RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
    demoPos[0] + 17,
    demoPos[1]
  );
  visual.animatedPosition(10, 10);
  visual.speech("Hello World!", 30, 10);
  return visual;
};

const ColorSets = {
  white: ["#ffffff", "#4c4c4c"],
  grey: ["#b4b4b4", "#4c4c4c"],
  red: ["#ff7b7b", "#592121"],
  yellow: ["#fdd388", "#5d4c2e"],
  green: ["#00f4a2", "#236144"],
  blue: ["#50d7f9", "#006181"],
  purple: ["#a071ff", "#371383"],
};

const ResourceColors = {
  [RESOURCE_ENERGY]: ColorSets.yellow,
  [RESOURCE_POWER]: ColorSets.red,

  [RESOURCE_HYDROGEN]: ColorSets.grey,
  [RESOURCE_OXYGEN]: ColorSets.grey,
  [RESOURCE_UTRIUM]: ColorSets.blue,
  [RESOURCE_LEMERGIUM]: ColorSets.green,
  [RESOURCE_KEANIUM]: ColorSets.purple,
  [RESOURCE_ZYNTHIUM]: ColorSets.yellow,
  [RESOURCE_CATALYST]: ColorSets.red,
  [RESOURCE_GHODIUM]: ColorSets.white,

  [RESOURCE_HYDROXIDE]: ColorSets.grey,
  [RESOURCE_ZYNTHIUM_KEANITE]: ColorSets.grey,
  [RESOURCE_UTRIUM_LEMERGITE]: ColorSets.grey,

  [RESOURCE_UTRIUM_HYDRIDE]: ColorSets.blue,
  [RESOURCE_UTRIUM_OXIDE]: ColorSets.blue,
  [RESOURCE_KEANIUM_HYDRIDE]: ColorSets.purple,
  [RESOURCE_KEANIUM_OXIDE]: ColorSets.purple,
  [RESOURCE_LEMERGIUM_HYDRIDE]: ColorSets.green,
  [RESOURCE_LEMERGIUM_OXIDE]: ColorSets.green,
  [RESOURCE_ZYNTHIUM_HYDRIDE]: ColorSets.yellow,
  [RESOURCE_ZYNTHIUM_OXIDE]: ColorSets.yellow,
  [RESOURCE_GHODIUM_HYDRIDE]: ColorSets.white,
  [RESOURCE_GHODIUM_OXIDE]: ColorSets.white,

  [RESOURCE_UTRIUM_ACID]: ColorSets.blue,
  [RESOURCE_UTRIUM_ALKALIDE]: ColorSets.blue,
  [RESOURCE_KEANIUM_ACID]: ColorSets.purple,
  [RESOURCE_KEANIUM_ALKALIDE]: ColorSets.purple,
  [RESOURCE_LEMERGIUM_ACID]: ColorSets.green,
  [RESOURCE_LEMERGIUM_ALKALIDE]: ColorSets.green,
  [RESOURCE_ZYNTHIUM_ACID]: ColorSets.yellow,
  [RESOURCE_ZYNTHIUM_ALKALIDE]: ColorSets.yellow,
  [RESOURCE_GHODIUM_ACID]: ColorSets.white,
  [RESOURCE_GHODIUM_ALKALIDE]: ColorSets.white,

  [RESOURCE_CATALYZED_UTRIUM_ACID]: ColorSets.blue,
  [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: ColorSets.blue,
  [RESOURCE_CATALYZED_KEANIUM_ACID]: ColorSets.purple,
  [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: ColorSets.purple,
  [RESOURCE_CATALYZED_LEMERGIUM_ACID]: ColorSets.green,
  [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: ColorSets.green,
  [RESOURCE_CATALYZED_ZYNTHIUM_ACID]: ColorSets.yellow,
  [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: ColorSets.yellow,
  [RESOURCE_CATALYZED_GHODIUM_ACID]: ColorSets.white,
  [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: ColorSets.white,
};

const MINERALS = [
  RESOURCE_CATALYST,
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_LEMERGIUM,
  RESOURCE_UTRIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_KEANIUM,
];

const drawFluid = function (
  visual: RoomVisual,
  type: ResourceConstant,
  x: number,
  y: number,
  size: number = 0.25
): RoomVisual {
  console.log("drawFluid", type, x, y, size);
  visual.circle(x, y, {
    radius: size,
    fill: ResourceColors[type][0],
    opacity: 1,
  });
  visual.text(type[0], x, y - size * 0.1, {
    font: size * 1.5,
    color: ResourceColors[type][1],
    backgroundColor: ResourceColors[type][0],
    backgroundPadding: 0,
  });
  return visual;
};

const drawMineral = function (
  visual: RoomVisual,
  type: MineralConstant,
  x: number,
  y: number,
  size: number = 0.25
): RoomVisual {
  visual.circle(x, y, {
    radius: size,
    fill: ResourceColors[type][0],
    opacity: 1,
  });
  visual.circle(x, y, {
    radius: size * 0.8,
    fill: ResourceColors[type][1],
    opacity: 1,
  });
  visual.text(type, x, y + size * 0.03, {
    font: "bold " + size * 1.25 + " arial",
    color: ResourceColors[type][0],
    backgroundColor: ResourceColors[type][1],
    backgroundPadding: 0,
  });
  return visual;
};

const drawCompound = function (
  visual: RoomVisual,
  type: MineralCompoundConstant,
  x: number,
  y: number,
  size: number = 0.25
): RoomVisual {
  let label = type.replace("2", "₂");

  visual.text(label, x, y, {
    font: "bold " + size * 1 + " arial",
    color: ResourceColors[type][1],
    backgroundColor: ResourceColors[type][0],
    backgroundPadding: 0.3 * size,
  });
  return visual;
};

const drawResource = function (
  visual: RoomVisual,
  type: ResourceConstant,
  x: number,
  y: number,
  size: number = 0.25
): RoomVisual {
  if (type === RESOURCE_ENERGY || type === RESOURCE_POWER)
    return drawFluid(visual, type, x, y, size);
  else if (MINERALS.includes(type as MineralConstant))
    return drawMineral(visual, type as MineralConstant, x, y, size);
  else if (ResourceColors[type] !== undefined)
    return drawCompound(visual, type as MineralCompoundConstant, x, y, size);
  return visual;
};

export {
  drawResource,
  test,
  animatedPosition,
  speech,
  connectRoads,
  drawStructure,
};
