/**
 * 文件摘要：Screeps 运行时提供、但 @types/screeps 未声明的全局对象。
 *
 * 所属位置：src/env.d.ts，仅类型声明，不产生构建输出；tsconfig 的 types 只含 screeps，不引入 DOM 或 Node 的声明，
 * 因此这里只声明游戏沙箱确实存在的最小接口。用 interface 加 var 声明：测试配置同时引入 @types/node 时，
 * 与 Node 的 Console 声明合并，而不是相互覆盖。
 */

/** 游戏控制台：输出显示在游戏界面的控制台中，每条输出都计入 CPU。 */
interface Console {
  /**
   * @description 向游戏控制台输出一行文本。
   * @param args 输出内容，按空格连接。
   * @returns 无返回值。
   */
  log(...args: unknown[]): void;
}

declare var console: Console;
