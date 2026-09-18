/**
 * 文件摘要
 *
 * 模块角色：utils/console 的资源导入类型声明，使 TypeScript 能识别 HTML 模板与样式文件。
 *
 * 主要功能：将任意 *.html 模块的默认导出声明为 string，供表单和帮助渲染器使用。
 *
 * 实现过程：用通配的环境模块声明描述导入结果，实际字符串内容由构建时的 htmlString 插件生成。
 *
 * 技术要点：保持无顶层 import/export，才能让通配声明在项目中生效。
 * 该文件不读取 HTML、不执行压缩，也不生成运行时代码；类型声明必须与构建插件的输出保持一致。
 */
declare module '*.html' {
  const content: string;
  export default content;
}
