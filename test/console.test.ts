/**
 * 文件摘要：验证控制台工具的“单行输出”契约与表单模板的内嵌按钮脚本。
 *
 * 覆盖范围：`src/utils/console/form/template.html` 的表单外层片段的按钮脚本能否在
 * `fixRetraction` 折叠换行后仍是合法 JavaScript。Screeps 控制台按行拆分日志，createForm
 * 因此会在返回前删除全部换行；一旦脚本里出现 `//` 行注释或依赖自动分号插入（ASI），
 * 折叠后的单行代码就会失效——这正是本用例要回归的行为。
 *
 * 运行方式与前提：普通 Jest（Node 环境，无需游戏全局对象）。这里直接读取模板源文件，
 * 并先按构建期 html-minifier 的 `removeComments: true` 去掉 HTML 注释，再走 split(';;')
 * 与 replaceHtml + fixRetraction，最后只做语法解析（`new Function` 不执行脚本，因此
 * document/angular 等浏览器对象不会真的被访问）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixRetraction, replaceHtml } from '@utils/console/utils';

// 具名导入而非默认导入：tsconfig 未开启 esModuleInterop，默认导入会取到 undefined。
const formTemplatePath = join(
  __dirname,
  '..',
  'src',
  'utils',
  'console',
  'form',
  'template.html'
);

/**
 * 去掉 HTML 注释，模拟构建期 Rollup htmlString 插件的 removeComments 行为。
 * 模板的说明注释里也含有 `;;` 字样，不先删除会让 split 得到多余片段。
 */
const stripHtmlComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');

/**
 * 复刻 createForm 的渲染流程，取出表单外层片段中的 onclick 脚本内容。
 * 占位符必须替换成合法字面量，否则解析失败会来自未替换的 `{...}` 而不是被考察的脚本。
 */
const renderButtonScript = (): string => {
  const [formTemplate] = stripHtmlComments(
    readFileSync(formTemplatePath, 'utf8')
  ).split(';;');
  const formHtml = fixRetraction(
    replaceHtml(formTemplate, {
      formName: 'demo1',
      formContent: '<div></div>',
      elementNames: "'a','b'",
      command: 'consoleCommand',
      buttonLabel: 'submit',
    })
  );
  const matched = formHtml.match(/onclick="([\s\S]*?)"\s*>/);
  if (!matched) throw new Error('form template has no onclick attribute');
  return matched[1];
};

describe('console form template', () => {
  it('folds the button script into a single line that still parses', () => {
    const script = renderButtonScript();

    // 折叠后不应残留换行，否则控制台仍会把同一段 HTML 拆成多条消息。
    expect(script.includes('\n')).toBe(false);
    // 解析成功即证明注释与分号写法对折叠安全；脚本本身不会被真正执行。
    expect(() => new Function(script)).not.toThrow();
  });
});
