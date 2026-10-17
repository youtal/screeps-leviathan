/**
 * 文件摘要：游戏入口，导出 Screeps 每 tick 调用的 `loop`。
 *
 * 所属位置：src/main.ts，构建入口（rollup.config.mjs 的 input）。
 * 当前内容是工具链占位：保证构建、类型检查与部署流程可以运行。
 * kernel 与保底循环实现后，本文件改为装配 kernel，并用保底循环包住整个 tick
 * （见 docs/design/architecture.md 的"保底循环"一节）。
 */
export const loop = (): void => {
  // 占位：kernel 实现前不执行任何游戏逻辑。
};
