import Layout from "@/modulesGlobal/Layout/layout";
import { AppLifecycleCallbacks } from "@/freamWork/types";

const roomName = Object.keys(Game.rooms)[0];
const layout = new Layout(roomName);

export const m4: AppLifecycleCallbacks = {
  tickEnd: () => {
    layout.show();
  },
};
