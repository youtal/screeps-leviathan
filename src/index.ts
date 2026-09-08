/**
 * 文件摘要：定义 Screeps 每 tick 调用的顶层 loop 入口。
 *
 * 当前入口仍处于项目骨架阶段，只输出 tick 编号；后续应用装配应从 app 层引入，
 * 并保持这里仅负责驱动运行时，避免在每个 tick 重建可复用模块。
 */
export const loop = (): void => {
  console.log(`Hello, world! ${Game.time}`);
};
