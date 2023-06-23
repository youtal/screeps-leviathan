import { visTest } from "@/modulesGlobal/roomVisiualPlus";
import { AppLifecycleCallbacks } from "@/freamWork/types";
import { workTask } from "@/role/types";
import { log } from "console";
const m3: AppLifecycleCallbacks = {
  tickStart: () => {
    const roomName = Object.keys(Game.rooms)[0];
    console.log(workTask.Build);
    console.log(Object.values(Game.rooms)[0].source);
    visTest(roomName);
  },
};

export { m3 };
