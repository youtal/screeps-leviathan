import { profileFunction } from "@/modulesGlobal/Profiler/Profiler";
import { AppLifecycleCallbacks } from "@/freamWork/types";
import { log, Color } from "@/utils";

let fn = () => {
  const room = Object.values(Game.spawns)[0].room;
  log(`${JSON.stringify(room, null, 2)}`, "testModule1", Color.Blue);
};

fn = profileFunction(fn);

export const testModule2: AppLifecycleCallbacks = {
  tickStart: () => {
    fn();
  },
};
