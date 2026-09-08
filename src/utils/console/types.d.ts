/**
 * 文件摘要：声明 HTML 文本导入和控制台日志配置的项目级类型。
 *
 * `*.html` 模块声明配合 Rollup 文本插件，让 TypeScript 把模板导入识别为
 * 字符串；LogOptions 保持全局可见，供日志工厂和 Runtime 配置共同使用。
 */
declare module '*.html' {
  const content: string;
  export default content;
}

/** 每个字段可选；未提供时由 createLog 回退到项目默认配置。 */
type LogOptions = {
  debug?: boolean;
  warn?: boolean;
  error?: boolean;
  success?: boolean;
  info?: boolean;
  report?: boolean;
};
