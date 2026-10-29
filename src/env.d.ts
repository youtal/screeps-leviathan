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
  /**
   * @description 向游戏控制台输出一行，内容原样交给客户端按 HTML 渲染，转义由调用方负责。官服的 log 会把内容整体
   * 转成 HTML 实体，标签无法渲染；logUnsafe 不做这一步。私服或旧版本可能没有此方法，使用前须检查。
   * @param args 输出内容，按空格连接。
   * @returns 无返回值。
   */
  logUnsafe?(...args: unknown[]): void;
}

declare var console: Console;

/**
 * 构建时注入的版本号（docs/design/kernel/bootPort.md 第 6 节）：rollup 的内联插件提供此虚拟模块，
 * 内容取自 package.json 的 version；单元测试由 Jest 的 moduleNameMapper 映射到测试替身。只有 app.assembly 导入它。
 */
declare module 'virtual:release' {
  /** 当前构建的版本号，例如 "0.1.9"。 */
  export const release: string;
}
