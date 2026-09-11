/**
 * 文件摘要：声明 HTML 文本导入和控制台日志配置的项目级类型。
 *
 * 模块位置：src/utils/console 的类型补充文件，与 utils.ts 同目录，但不产生任何运行时代码。
 * 本文件没有顶层 import/export，因此其中所有声明都是全局的：`*.html` 通配模块声明让
 * TypeScript 接受模板导入，LogOptions 供 createLog 与 Runtime 的 ModuleContextOptions
 * 共同引用（两者都不需要 import 即可使用该全局类型）。
 *
 * `*.html` 模块声明配合 Rollup 的 htmlString 插件（build/rollupPlugins.mjs）：插件对
 * `.html` 文件执行 html-minifier-terser，再以 `export default "<minified string>"` 的形式
 * 输出模块，因此这里把默认导出标注为 string。项目构建使用
 * `removeComments: true`、`collapseWhitespace: true`、`minifyCSS: true`，即 HTML 注释、
 * 缩进和样式空白在构建期就被压缩掉；类型侧只描述字符串契约，不校验模板内容。
 * 与 `allowSyntheticDefaultImports: true`（tsconfig）配合，`import template from './x.html'`
 * 才能通过编译，这与插件生成的默认导出形式一致。
 */

/** 通配声明：任意以 .html 结尾的导入都解析为本模块，默认导出为构建后的 HTML 字符串。 */
declare module '*.html' {
  const content: string;
  export default content;
}

/**
 * 每个字段可选；未提供时由 createLog 回退到项目默认配置。
 *
 * 语义约定：字段为 undefined 表示“跟随 DEFAULT_LOG_CONFIG”，显式传入 false 才是关闭，
 * 这一区分依赖 createLog 中的 `??`；五个等级与 report 都遵循同一规则。
 */
type LogOptions = {
  debug?: boolean;
  warn?: boolean;
  error?: boolean;
  success?: boolean;
  info?: boolean;
  report?: boolean;
};
