/**
 * 文件摘要：作为通用工具层（src/utils）的统一出口，聚合控制台工具与泛型优先队列。
 *
 * 模块位置：位于具体实现（`console/` 目录与 `priorityQueue.ts`）之上的 barrel 文件，
 * 是上层模块引用工具能力的推荐入口，避免业务代码直接依赖 utils 的内部文件布局。
 *
 * 主要输入 / 输出：本文件不定义任何值，只做 ESM 再导出。对外能力由两部分组成：
 * - `export *` 透传 `./console` 自身的公共出口（格式化、着色、日志工厂），
 *   使 console 目录内部调整导出时无需同步修改本文件；
 * - `PriorityQueue` 显式具名导出，让入口的导出清单保持可读、可检索。
 *
 * 状态与副作用：再导出只在模块求值期建立引用绑定，不执行逻辑、不创建缓存、
 * 不访问 Game 或 Memory，因此没有运行时副作用和 CPU 开销；打包阶段可被
 * tree-shaking 裁剪，不会因为存在该入口而把未使用的实现打进产物。
 */
export * from './console';
export { PriorityQueue } from './priorityQueue';
