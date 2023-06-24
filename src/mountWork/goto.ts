import { AppLifecycleCallbacks } from "@/freamWork/types";
import { goto } from "@/modulesGlobal/Goto";
import { moveOption } from "@/modulesGlobal/Goto/types";

export const pluginGoto: AppLifecycleCallbacks = {
  reload: () => {
    Object.defineProperty(Creep.prototype, "goto", {
      value: function (
        target: RoomPosition | { pos: RoomPosition },
        option?: moveOption
      ) {
        return goto(this, target, option);
      },
    });
  },
};
