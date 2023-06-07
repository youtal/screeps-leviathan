import { visTest } from "@/modulesGlobal/roomVisiualPlus";
import { AppLifecycleCallbacks } from "@/freamWork/types";

const m3: AppLifecycleCallbacks = {
  tickStart: () => {
    const roomName = Object.keys(Game.rooms)[0];
    visTest(roomName);
  },
};

export { m3 };
