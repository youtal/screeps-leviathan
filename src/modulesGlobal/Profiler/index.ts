import { createProfiler } from "./Profiler";
import { AppLifecycleCallbacks } from "@/freamWork/types";

export const {
  init,
  start,
  stop,
  clear,
  reset,
  output,
  status,
  showMore,
  showLess,
} = createProfiler();
export { profileFunction, profile } from "./Profiler";

export const profilerModule: AppLifecycleCallbacks = {
  reload: () => {
    init();
  },
};
