/**
 * 文件摘要：作为控制台工具（src/utils/console）的公共出口，当前只暴露通用格式化与日志函数。
 *
 * 模块位置：console 目录的 barrel，向下汇总 `utils.ts`（模板替换、着色、链接、日志工厂），
 * 向上由 `src/utils/index.ts` 再导出。
 *
 * 主要输入 / 输出：对外能力完全来自 `export * from './utils'`；本文件自身不定义值，
 * 因此新增工具函数只需在 utils.ts 中导出即可自动出现在此处。
 *
 * 状态与副作用：再导出不产生运行时开销。帮助与表单实现已经存在，但尚未按项目规范
 * 补齐 docs/ 模块文档与测试验证，因此暂不进入公共 API；不导出它们同时避免上层无意间
 * 求值 createHelp.ts 中开发期的模块级 console.log 副作用。启用前应先补齐文档与验证，
 * 再恢复下方预留的具名导出（其签名分别来自 help/types.ts 与 form/types.ts）。
 */
// 预留公共导出：export { createHelp } from './help/createHelp';
// 预留公共导出：export { createForm } from './form/createForm';
// 预留公共导出：export { getForm } from './form/example';
export * from './utils';
