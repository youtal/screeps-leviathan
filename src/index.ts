import { createApp } from "@/freamWork";
import { testModule1 } from "./testModuels/m1";

const app = createApp();
app.use(testModule1);

export const loop = app.run;
