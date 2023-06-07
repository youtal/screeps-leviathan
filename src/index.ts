import { createApp } from "@/freamWork";
import { roomShortcutsPlugin } from "./mountWork";
import { profilerModule } from "./modulesGlobal/Profiler";
import { visPlusPlugin } from "./modulesGlobal/roomVisiualPlus";
import { m3 } from "./testModuels/m3";

const app = createApp();
app.use(roomShortcutsPlugin);
app.use(visPlusPlugin);
app.use(m3);

app.use(profilerModule);

export const loop = app.run;
