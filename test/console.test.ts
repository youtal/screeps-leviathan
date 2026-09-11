/**
 * 文件摘要：验证控制台工具的“单行输出”契约、表单模板按钮脚本与日志等级开关。
 *
 * 覆盖范围：
 * 1. `src/utils/console/form/template.html` 的表单外层片段按钮脚本能否在 `fixRetraction`
 *    折叠换行后仍是合法 JavaScript。Screeps 控制台按行拆分日志，createForm 因此会在返回前
 *    删除全部换行；一旦脚本里出现 `//` 行注释或依赖自动分号插入（ASI），折叠后的单行代码
 *    就会失效——这正是第一个用例要回归的行为。
 * 2. `createLog` 的等级回退规则：六个等级（含 report）都必须支持 `opt[字段] ?? 默认值`，
 *    显式 false 只关闭该等级，不影响其它等级。
 *
 * 运行方式与前提：普通 Jest（Node 环境，无需游戏全局对象）。模板用例直接读取源文件，
 * 并先按构建期 html-minifier 的 `removeComments: true` 去掉 HTML 注释，再走 split(';;')
 * 与 replaceHtml + fixRetraction，最后只做语法解析（`new Function` 不执行脚本，因此
 * document/angular 等浏览器对象不会真的被访问）；日志用例用 spy 拦截 console.log。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLog, fixRetraction, replaceHtml } from '@utils/console/utils';

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

describe('createLog level switches', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * 拦截 console.log 并返回“读取本轮输出”的函数。
   * 所有等级最终都走底层 log → console.log，因此一次捕获即可观察全部等级。
   */
  const captureConsoleLog = (): (() => string) => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    return () => spy.mock.calls.map((call) => String(call[0])).join('\n');
  };

  it('falls back to the default report switch when not overridden', () => {
    const output = captureConsoleLog();

    // DEFAULT_LOG_CONFIG.report 为 true，未传 report 时应照常输出。
    createLog('Test', {}).report('report-default');

    expect(output()).toContain('report-default');
  });

  it('honours an explicit report override without affecting other levels', () => {
    const output = captureConsoleLog();
    const logger = createLog('Test', {
      debug: true,
      warn: false,
      error: false,
      success: false,
      info: false,
      report: false,
    });

    logger.report('hidden-report');
    logger.debug('shown-debug');

    const text = output();
    expect(text).not.toContain('hidden-report');
    expect(text).toContain('shown-debug');
  });
});
