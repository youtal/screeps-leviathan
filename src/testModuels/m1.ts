import { AppLifecycleCallbacks } from "@/freamWork/types";
import { log, Color } from "@/utils";

export const testModule1: AppLifecycleCallbacks = {
  tickStart: () => {
    log(`${Game.time}`, "testModule1", Color.Blue);
  },
};
