import {
  drawResource,
  test,
  animatedPosition,
  speech,
  connectRoads,
  drawStructure,
} from "./roomVisiualPlus";
import { AppLifecycleCallbacks } from "@/freamWork/types";
import { profileFunction } from "@/modulesGlobal/Profiler";

const mount = function () {
  Object.defineProperty(RoomVisual.prototype, "test", {
    value: function () {
      return test(this);
    },
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(RoomVisual.prototype, "resource", {
    value: function (resourceType: ResourceConstant, x: number, y: number) {
      return drawResource(this, resourceType, x, y);
    },
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(RoomVisual.prototype, "animatedPosition", {
    value: function (x: number, y: number, opts: CircleStyle) {
      return animatedPosition(this, x, y, opts);
    },
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(RoomVisual.prototype, "speech", {
    value: function (text: string, x: number, y: number, opts: TextStyle) {
      return speech(this, text, x, y, opts);
    },
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(RoomVisual.prototype, "connectRoads", {
    value: function () {
      return connectRoads(this);
    },
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(RoomVisual.prototype, "structure", {
    value: function (
      x: number,
      y: number,
      type: DrawableStructure,
      opts?: any
    ) {
      return drawStructure(this, type, x, y, opts);
    },
  });
};

let toDraw: {
  [key: string]: {
    test: boolean;
    resource: { type: ResourceConstant; x: number; y: number; size: number }[];
    animate: { x: number; y: number; opts: any }[];
    speech: { text: string; x: number; y: number; opts: TextStyle }[];
    connectRoads: { ops: LineStyle }[];
    structure: { x: number; y: number; type: DrawableStructure; opts: any }[];
  };
} = {};

const recordArgs = function (roomName: string, key: string, args) {
  if (!toDraw[roomName]) {
    toDraw[roomName] = {
      test: false,
      resource: [],
      animate: [],
      speech: [],
      connectRoads: [],
      structure: [],
    };
  }
  toDraw[roomName][key].push(args);
};

const visTest = function (room: Room | string) {
  if (typeof room !== "string") {
    room = room.name;
  }
  if (!toDraw[room]) {
    toDraw[room] = {
      test: false,
      resource: [],
      animate: [],
      speech: [],
      connectRoads: [],
      structure: [],
    };
  }
  toDraw[room].test = true;
};

const visResource = function (
  room: Room | string,
  type: ResourceConstant,
  x: number,
  y: number,
  size: number
) {
  if (typeof room !== "string") {
    room = room.name;
  }
  recordArgs(room, "resource", { type, x, y, size });
};

const visAnimatedPosition = function (
  room: Room | string,
  x: number,
  y: number,
  opts
) {
  if (typeof room !== "string") {
    room = room.name;
  }
  recordArgs(room, "animate", { x, y, opts });
};

const visSpeech = function (room: Room | string, text, x, y, opts) {
  if (typeof room !== "string") {
    room = room.name;
  }
  recordArgs(room, "speech", { text, x, y, opts });
};

const visConnectRoads = function (room: Room | string, opts) {
  if (typeof room !== "string") {
    room = room.name;
  }
  recordArgs(room, "connectRoads", { opts });
};

const visStructure = function (room: Room | string, x, y, type, opts) {
  if (typeof room !== "string") {
    room = room.name;
  }
  recordArgs(room, "structure", { x, y, type, opts });
};

let execute = function () {
  for (const roomName in toDraw) {
    const room = Game.rooms[roomName];
    if (!room) continue;
    const roomVisual = new RoomVisual(roomName);
    if (!roomVisual) continue;
    const args = toDraw[roomName];
    if (args.test) {
      test(roomVisual);
    }
    for (const resource of args.resource) {
      drawResource(roomVisual, resource.type, resource.x, resource.y);
    }
    for (const animate of args.animate) {
      animatedPosition(roomVisual, animate.x, animate.y, animate.opts);
    }
    for (const speechArgs of args.speech) {
      speech(
        roomVisual,
        speechArgs.text,
        speechArgs.x,
        speechArgs.y,
        speechArgs.opts
      );
    }
    for (const connectRoadsArgs of args.connectRoads) {
      connectRoads(roomVisual, connectRoadsArgs.ops);
    }
    for (const structure of args.structure) {
      drawStructure(
        roomVisual,
        structure.type,
        structure.x,
        structure.y,
        structure.opts
      );
    }
  }
  toDraw = {};
};

execute = profileFunction(execute, "roomVisualPlus");

const visPlusPlugin: AppLifecycleCallbacks = {
  reload: mount,
  tickEnd: execute,
};

export {
  visPlusPlugin,
  visTest,
  visResource,
  visAnimatedPosition,
  visSpeech,
  visConnectRoads,
  visStructure,
};
