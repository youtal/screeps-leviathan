import { AppLifecycleCallbacks } from "@/freamWork/types";
import { roomShortcutsPlugin } from "./Roomshortcuts";
import { pluginGoto } from "./goto";
import { assmblePlugins } from "@/utils";

const mountWork = [roomShortcutsPlugin, pluginGoto];

export const mountWorkPlugin: AppLifecycleCallbacks = assmblePlugins(mountWork);
