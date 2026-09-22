/**
 * 文件摘要：Jest 的 .html 模块转换器，使测试可以直接导入依赖 HTML 模板的源码
 * （createForm、createHelp）。
 *
 * 与构建的对应关系：生产构建由 build/rollupPlugins.mjs 的 htmlString 插件把 .html
 * 压缩成默认导出的字符串。这里只复刻其中影响片段划分的一步，即删除 HTML 注释：
 * 渲染器按 `;;` 切分模板并按位置解构，产物中的注释已被删除，注释里即使出现分隔符
 * 字样也不影响产物，测试中同样不应受影响。不复刻空白折叠：html-minifier-terser 的 minify 是异步函数，而 Jest 加载 CommonJS
 * 模块时只调用同步的 process。渲染器最终都会用 fixRetraction 删除换行，测试只断言
 * 结构，不断言空白。
 *
 * 导出形式：tsconfig 未开启 esModuleInterop，`import tpl from './x.html'` 被编译为读取
 * require 结果的 `.default`，因此输出带 __esModule 标记的 default 导出。
 *
 * 缓存：Jest 默认的转换缓存键只包含被转换文件的内容、路径与配置，不包含转换器自身。
 * getCacheKey 把本文件内容一并纳入，修改转换器后旧的转换结果自动失效。
 */
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

/** 转换器自身的源码，参与缓存键计算；模块加载时读取一次。 */
const selfSource = readFileSync(__filename, 'utf8');

/** 与 htmlString 插件的 removeComments 选项对应：删除全部 HTML 注释。 */
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

module.exports = {
  process(sourceText) {
    return {
      code:
        'Object.defineProperty(exports, "__esModule", { value: true });\n' +
        'exports.default = ' +
        JSON.stringify(stripHtmlComments(sourceText)) +
        ';\n',
    };
  },

  getCacheKey(sourceText, sourcePath, options) {
    return createHash('sha1')
      .update(selfSource)
      .update('\0')
      .update(sourceText)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(options.configString)
      .digest('hex');
  },
};
