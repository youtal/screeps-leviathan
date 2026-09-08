/**
 * 文件摘要：作为控制台工具公共出口，当前只暴露通用格式化与日志函数。
 *
 * 帮助和表单模块仍处于开发状态，因此暂不进入公共 API；需要启用时应先补齐
 * 模块验证与文档，再恢复相应导出。
 */
// 预留公共导出：export { createHelp } from './help/createHelp';
// 预留公共导出：export { createForm } from './form/createForm';
// 预留公共导出：export { getForm } from './form/example';
export * from './utils';
