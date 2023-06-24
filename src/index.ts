import { createApp } from "@/freamWork";
import { profilerModule } from "./modulesGlobal/Profiler";
import { visPlusPlugin } from "./modulesGlobal/roomVisiualPlus";
import { mountWorkPlugin } from "./mountWork";
import { m3 } from "./testModuels/m3";

const app = createApp();
app.use(visPlusPlugin);
app.use(mountWorkPlugin);
app.use(m3);

app.use(profilerModule);

export const loop = app.run;
