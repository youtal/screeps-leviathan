/**
 * 文件摘要：为 console 模板声明 HTML 字符串导入，与构建期 htmlString 插件配套。
 * 无顶层 import/export 以保留通配环境模块声明；不产生运行时副作用。
 * 日志公共类型改由 contracts/logging 显式发布。
 */
declare module '*.html' {
  const content: string;
  export default content;
}
