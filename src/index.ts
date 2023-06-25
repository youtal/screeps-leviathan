import { createApp } from "@/freamWork";
import { profilerModule } from "./modulesGlobal/Profiler";
import { visPlusPlugin } from "./modulesGlobal/roomVisiualPlus";
import { mountWorkPlugin } from "./mountWork";
import { m4 } from "./testModuels/m4";

const app = createApp();
app.use(visPlusPlugin);
app.use(mountWorkPlugin);

app.use(profilerModule);

app.use(m4);

export const loop = app.run;
