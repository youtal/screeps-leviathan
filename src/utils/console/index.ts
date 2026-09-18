/**
 * 文件摘要
 *
 * 模块角色：utils/console 的公共入口，向通用工具层与 Logger 提供文本格式化能力。
 *
 * 主要功能：导出模板替换、换行处理、颜色和链接生成工具。
 *
 * 实现过程：转发 utils.ts 的全部公开符号；帮助面板、表单和表单示例的导出仍是注释中的预留项。
 *
 * 技术要点：本文件不打印日志、渲染面板或持有缓存；导出工具在被调用时才执行各自操作。
 * 表单与帮助实现没有通过此入口开放，不能仅凭存在对应目录就从这里导入它们。
 */
// 预留公共导出：export { createHelp } from './help/createHelp';
// 预留公共导出：export { createForm } from './form/createForm';
// 预留公共导出：export { getForm } from './form/example';
export * from './utils';
