import { createApp } from "@/freamWork";
import { testModule1 } from "./testModuels/m1";
import { testModule2 } from "./testModuels/m2";
import { roomShortcutsPlugin } from "./mountWork";
import { profilerModule } from "./modulesGlobal/Profiler";

const app = createApp();
//app.use(testModule2);
app.use(roomShortcutsPlugin);

app.use(profilerModule);

export const loop = app.run;
