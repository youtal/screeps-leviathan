/**
 * 文件摘要：验证控制台模板工具的单行输出契约（表单按钮脚本折叠后仍可解析）。
 *
 * 覆盖范围：`src/utils/console/form/template.html` 的表单外层片段按钮脚本能否在
 * `fixRetraction` 折叠换行后仍是合法 JavaScript。Screeps 控制台按行拆分日志，
 * createForm 因此会在返回前删除全部换行；一旦脚本里出现 `//` 行注释或依赖自动
 * 分号插入（ASI），折叠后的单行代码就会失效——这正是本用例要回归的行为。
 * 日志等级与输出端口的回归见 test/logger.test.ts。
 *
 * 分段契约：createForm 与 createHelp 都在模块求值期按 `;;` 切分模板并按位置解构，
 * 因此本用例同时回归“连续分隔符产生的空片段”：空片段必须原位保留、渲染为空串，
 * 不得让后续片段整体前移错配，也不得退化成 undefined 槽位或抛错。
 *
 * 运行方式与前提：普通 Jest（Node 环境，无需游戏全局对象）。用例直接读取源文件，
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
const helpTemplatePath = join(
  __dirname,
  '..',
  'src',
  'utils',
  'console',
  'help',
  'template.html'
);

/**
 * 去掉 HTML 注释，模拟构建期 Rollup htmlString 插件的 removeComments 行为。
 * 模板的说明注释里也含有 `;;` 字样，不先删除会让 split 得到多余片段。
 */
const stripHtmlComments = (html: string): string =>
  html.replace(/<!--[\s\S]*?-->/g, '');

/**
 * 复刻 createForm/createHelp 在模块求值期的分段动作：先去注释，再按 `;;` 切分。
 * 保持 split 的原始结果（不 trim、不过滤空串），因为渲染器按下标解构固定数量的片段：
 * 过滤空片段会让后续片段整体前移，反而把模板槽位映射错位。
 */
const splitTemplateSegments = (template: string): string[] =>
  stripHtmlComments(template).split(';;');

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

describe('console template segments', () => {
  it('keeps empty segments from consecutive separators in place', () => {
    // `;;` 是片段分隔符而不是语句终止符，因此单个 `;` 不会切出空段。
    expect(splitTemplateSegments('a();')).toEqual(['a();']);
    // 相邻两个分隔符（;;;;）切出一个空片段：必须原位保留，否则后续片段会前移错配槽位。
    expect(splitTemplateSegments('a();;;;b()')).toEqual(['a()', '', 'b()']);
    // 尾随分隔符只在末尾追加一个空片段，不影响已经对齐的前缀槽位。
    expect(splitTemplateSegments('a();;b();;')).toEqual(['a()', 'b()', '']);
  });

  it('renders an empty segment as an empty string without throwing', () => {
    // 空片段同样会进入 replaceHtml + fixRetraction，必须退化为空串，
    // 而不是抛错或把字面量 "undefined" 拼进返回的 HTML。
    const [, emptySegment] = splitTemplateSegments('a();;;;b()');
    expect(emptySegment).toBe('');
    expect(() =>
      replaceHtml(emptySegment, { formName: 'demo', content: 'x' })
    ).not.toThrow();
    expect(fixRetraction(replaceHtml(emptySegment, { content: 'x' }))).toBe('');
  });

  it('keeps the shipped form and help templates free of empty segments', () => {
    const formSegments = splitTemplateSegments(
      readFileSync(formTemplatePath, 'utf8')
    );
    const helpSegments = splitTemplateSegments(
      readFileSync(helpTemplatePath, 'utf8')
    );

    // 片段数量必须与 createForm（7 段）/ createHelp（4 段）的位置解构一致，且没有空槽位。
    expect(formSegments).toHaveLength(7);
    expect(helpSegments).toHaveLength(4);
    expect(formSegments).not.toContain('');
    expect(helpSegments).not.toContain('');
  });
});
