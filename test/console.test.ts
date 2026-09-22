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
 * 运行方式与前提：普通 Jest（Node 环境）。模板相关用例直接读取源文件，
 * 并先按构建期 html-minifier 的 `removeComments: true` 去掉 HTML 注释，再走 split(';;')
 * 与 replaceHtml + fixRetraction，最后只做语法解析（`new Function` 不执行脚本，因此
 * document/angular 等浏览器对象不会真的被访问）。
 *
 * 渲染器测试：createForm、createHelp 经 test/support/htmlTransform.cjs 导入模板，
 * 两者都读取 Game.time 生成 DOM 名称，因此用例在 beforeEach 中注入只含 time 的 Game。
 * 除结构断言（单行、控件与字段、占位符全部替换、按钮脚本可解析、调用形式）外，还覆盖
 * A11 的信任边界：文本与属性按 HTML 转义、标识符不合法时抛错、同 tick 重复渲染不重名；
 * 以及 G09：按钮脚本在单个 checkbox/radio 上也按选中态取值。按钮脚本在 Node 中用
 * document/RadioNodeList/angular 桩执行，不需要浏览器依赖。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dyeBlue,
  dyeGreen,
  dyeYellow,
  fixRetraction,
  replaceHtml,
} from '@utils/console/utils';
import { createForm } from '@utils/console/form/createForm';
import { createHelp } from '@utils/console/help/createHelp';

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
 * 产物中不含注释，注释里若出现 `;;` 字样也不会影响产物的分段，测试须与之一致。
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

/** F6：替换值按字面量写入，键名按字面量匹配。 */
describe('replaceHtml literal handling', () => {
  it('keeps $ replacement patterns in values literally', () => {
    expect(
      replaceHtml('<b>{content}</b>', { content: 'cost $& and $1 and $$' })
    ).toBe('<b>cost $& and $1 and $$</b>');
  });

  it('matches placeholder keys containing regex metacharacters literally', () => {
    expect(replaceHtml('{a.b} {aXb}', { 'a.b': 'dot' })).toBe('dot {aXb}');
  });
});

/**
 * 取出渲染结果中按钮的 onclick 脚本。
 * 与 renderButtonScript 不同，这里的输入来自真实的 createForm 输出。
 */
const extractButtonScript = (html: string): string => {
  const matched = html.match(/onclick="([\s\S]*?)"\s*>/);
  if (!matched) throw new Error('rendered form has no onclick attribute');
  return matched[1];
};

/** 断言渲染结果中不残留任何模板占位符。 */
const expectNoPlaceholders = (html: string, placeholders: string[]): void => {
  for (const placeholder of placeholders) {
    expect(html).not.toContain(`{${placeholder}}`);
  }
};

describe('createForm', () => {
  beforeEach(() => {
    (global as any).Game = { time: 123 };
  });

  afterEach(() => {
    delete (global as any).Game;
  });

  it('renders every control type, the field names and the submit button', () => {
    const options = [
      { value: '0', label: 'OptionA' },
      { value: '1', label: 'OptionB' },
    ];
    const html = createForm(
      'demo',
      [
        {
          name: 'myInput',
          label: 'InputLabel',
          type: 'input',
          placeholder: 'InputHint',
        },
        { name: 'mySelect', label: 'SelectLabel', type: 'select', options },
        { name: 'myCheckbox', label: 'CheckLabel', type: 'checkbox', options },
        { name: 'myRadio', label: 'RadioLabel', type: 'radio', options },
      ],
      { content: 'Submit', command: 'myCommand' }
    );

    // 控制台按行拆分输出，渲染结果必须是单行。
    expect(html.includes('\n')).toBe(false);
    // 表单名由名称、Game.time 与渲染序号组成，同一名称同时用于 form 属性与按钮脚本的查询。
    const formName = html.match(/<form name="(demo123_\d+)">/)?.[1];
    expect(formName).toBeDefined();
    expect(html).toContain(`document.forms['${formName}']`);
    // 字段名按声明顺序进入按钮脚本的数组字面量。
    expect(html).toContain(
      "['myInput','mySelect','myCheckbox','myRadio'].map("
    );

    expect(html).toContain('<input name="myInput" placeholder="InputHint"');
    expect(html).toContain('<select name="mySelect"');
    expect(html).toContain('<option value="0">OptionA</option>');
    expect(html).toContain('<option value="1">OptionB</option>');
    // 复选与单选按候选项展开为同名控件，浏览器据此分组。
    expect(html.split('type="checkbox" name="myCheckbox"')).toHaveLength(3);
    expect(html.split('type="radio" name="myRadio"')).toHaveLength(3);
    for (const label of [
      'InputLabel',
      'SelectLabel',
      'CheckLabel',
      'RadioLabel',
    ]) {
      expect(html).toContain(`<span>${label}</span>`);
    }

    expect(html).toContain('>Submit</button>');
    const script = extractButtonScript(html);
    expect(script).toContain('(myCommand)(');
    // 真实渲染结果中的按钮脚本同样必须在折叠后可解析（只解析，不执行）。
    expect(() => new Function(script)).not.toThrow();

    expectNoPlaceholders(html, [
      'formName',
      'formContent',
      'elementNames',
      'command',
      'buttonLabel',
      'name',
      'label',
      'content',
      'option',
      'value',
      'placeholder',
    ]);
  });

  it('renders a form without fields as an empty name list', () => {
    const html = createForm('empty', [], { content: 'Go', command: 'run' });
    const script = extractButtonScript(html);

    expect(html).toMatch(/<form name="empty123_\d+">/);
    expect(script).toContain('[].map(');
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('createHelp', () => {
  beforeEach(() => {
    (global as any).Game = { time: 123 };
  });

  afterEach(() => {
    delete (global as any).Game;
  });

  it('renders modules, API entries, parameters and call forms', () => {
    const html = createHelp(
      {
        name: 'ModuleA',
        describe: 'ModuleA intro',
        api: [
          {
            title: 'Work',
            describe: 'Does work',
            params: [
              { name: 'roomName', desc: 'Target room' },
              { name: 'count', desc: 'How many' },
            ],
            functionName: 'doWork',
          },
          { title: 'Status', functionName: 'status', commandType: true },
        ],
      },
      { name: 'ModuleB', describe: 'ModuleB intro', api: [] }
    );

    expect(html.includes('\n')).toBe(false);
    // 多个模块依次渲染在同一个外层容器中。
    expect(html.split('class="module-help"')).toHaveLength(2);
    expect(html.split('class="module-container"')).toHaveLength(3);
    expect(html.indexOf(dyeYellow('ModuleA'))).toBeLessThan(
      html.indexOf(dyeYellow('ModuleB'))
    );
    expect(html).toContain(dyeGreen('ModuleA intro'));

    // 折叠控件的 id 由函数名、Game.time 与渲染序号组成，label 与 input 共用同一个值。
    for (const name of ['doWork', 'status']) {
      const id = html.match(new RegExp(`for="(${name}123_\\d+)"`))?.[1];
      expect(id).toBeDefined();
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain(`Work ${dyeYellow('doWork', true)}`);
    expect(html).toContain(dyeGreen('Does work'));
    expect(html).toContain(
      `  - ${dyeBlue('roomName')}: ${dyeGreen('Target room')}`
    );
    expect(html).toContain(`  - ${dyeBlue('count')}: ${dyeGreen('How many')}`);
    // 普通函数展示带参数的调用形式；命令型入口只展示名称，不带括号。
    expect(html).toContain(
      `${dyeYellow('doWork')}(${dyeBlue('roomName')}, ${dyeBlue('count')})`
    );
    expect(html).toContain(dyeYellow('status'));
    expect(html).not.toContain(`${dyeYellow('status')}(`);

    expectNoPlaceholders(html, [
      'checkboxId',
      'content',
      'describe',
      'functionList',
      'title',
    ]);
  });

  it('keeps empty parentheses for a function without parameters', () => {
    const html = createHelp({
      name: 'ModuleC',
      describe: 'ModuleC intro',
      api: [{ title: 'Ping', functionName: 'ping' }],
    });

    expect(html).toContain(`${dyeYellow('ping')}()`);
  });
});

/**
 * 用桩在 Node 中执行按钮脚本：浏览器里 `form[name]` 在同名控件只有一个时返回元素本身，
 * 多个时返回 RadioNodeList，这正是 G09 的根源，因此桩要同时提供这两种形态。
 */
class FakeRadioNodeList extends Array<{
  type: string;
  value: string;
  checked?: boolean;
}> {}

const radioNodeList = (
  ...items: { type: string; value: string; checked?: boolean }[]
): FakeRadioNodeList => {
  const list = new FakeRadioNodeList();
  list.push(...items);
  return list;
};

/** 执行表单按钮的 onclick 脚本，返回它最终交给控制台的命令文本。 */
const runButtonScript = (
  html: string,
  fields: { [name: string]: unknown }
): string => {
  const script = extractButtonScript(html);
  const formName = html.match(/<form name="([^"]+)">/)![1];
  let sent = '';
  const angular = {
    element: () => ({
      injector: () => ({
        get: () => ({
          sendCommand: (text: string) => {
            sent = text;
          },
        }),
      }),
    }),
  };
  const document = { forms: { [formName]: fields }, body: {} };
  new Function('document', 'RadioNodeList', 'angular', script)(
    document,
    FakeRadioNodeList,
    angular
  );
  return sent;
};

/** 取出渲染结果中的表单 DOM 名称。 */
const formNameOf = (html: string): string =>
  html.match(/<form name="([^"]+)">/)![1];

describe('console form button script', () => {
  beforeEach(() => {
    (global as any).Game = { time: 123 };
  });

  afterEach(() => {
    delete (global as any).Game;
  });

  const html = () =>
    createForm(
      'pick',
      [
        { name: 'text', label: 'T', type: 'input' },
        {
          name: 'flags',
          label: 'F',
          type: 'checkbox',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
        {
          name: 'mode',
          label: 'M',
          type: 'radio',
          options: [
            { value: 'x', label: 'X' },
            { value: 'y', label: 'Y' },
          ],
        },
      ],
      { content: 'Submit', command: 'cmd' }
    );

  it('collects grouped checkbox and radio values by checked state', () => {
    const sent = runButtonScript(html(), {
      text: { type: 'text', value: 'hello' },
      flags: radioNodeList(
        { type: 'checkbox', value: 'a', checked: false },
        { type: 'checkbox', value: 'b', checked: true }
      ),
      mode: radioNodeList(
        { type: 'radio', value: 'x', checked: false },
        { type: 'radio', value: 'y', checked: true }
      ),
    });

    expect(sent).toBe('(cmd)({"text":"hello","flags":["b"],"mode":"y"})');
  });

  /** G09：单个选项时 form[name] 返回元素本身，旧实现走 .value 分支，未勾选也会提交值。 */
  it('respects the checked state when a group has a single option', () => {
    const single = createForm(
      'one',
      [
        {
          name: 'flag',
          label: 'F',
          type: 'checkbox',
          options: [{ value: 'on', label: 'On' }],
        },
        {
          name: 'mode',
          label: 'M',
          type: 'radio',
          options: [{ value: 'x', label: 'X' }],
        },
      ],
      { content: 'Submit', command: 'cmd' }
    );

    expect(
      runButtonScript(single, {
        flag: { type: 'checkbox', value: 'on', checked: false },
        mode: { type: 'radio', value: 'x', checked: false },
      })
    ).toBe('(cmd)({"flag":[],"mode":""})');

    expect(
      runButtonScript(single, {
        flag: { type: 'checkbox', value: 'on', checked: true },
        mode: { type: 'radio', value: 'x', checked: true },
      })
    ).toBe('(cmd)({"flag":["on"],"mode":"x"})');
  });
});

/** A11：控制台按 HTML 渲染并执行内联事件处理器，外来文本必须转义、标识符必须受限。 */
describe('console trust boundary', () => {
  beforeEach(() => {
    (global as any).Game = { time: 123 };
  });

  afterEach(() => {
    delete (global as any).Game;
  });

  it('escapes form text and attribute values', () => {
    const html = createForm(
      'demo',
      [
        {
          name: 'note',
          label: '<img src=x onerror=alert(1)>',
          type: 'input',
          placeholder: 'a"b',
        },
        {
          name: 'pick',
          label: 'L',
          type: 'select',
          options: [{ value: '<v>', label: '&amp' }],
        },
      ],
      { content: '<b>go</b>', command: 'cmd' }
    );

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('placeholder="a&quot;b"');
    expect(html).toContain('<option value="&lt;v&gt;">&amp;amp</option>');
    expect(html).toContain('>&lt;b&gt;go&lt;/b&gt;</button>');
  });

  /** replaceHtml 逐键替换且结果参与后续替换：文本中的占位符必须先失效。 */
  it('keeps placeholder-like text out of the replacement cascade', () => {
    const html = createForm(
      'demo',
      [{ name: 'note', label: '{content}', type: 'input' }],
      { content: 'go', command: 'cmd' }
    );

    expect(html).toContain('<span>&#123;content&#125;</span>');
    expect(html).not.toContain('<span><input');
  });

  it('rejects identifiers that would break the attribute or the inline script', () => {
    const button = { content: 'go', command: 'cmd' };
    expect(() => createForm("de'mo", [], button)).toThrow(/Unsafe form name/);
    expect(() =>
      createForm('demo', [{ name: 'a"b', label: 'L', type: 'input' }], button)
    ).toThrow(/Unsafe field name/);
    expect(() =>
      createForm('demo', [], { content: 'go', command: 'send(`x`)' })
    ).toThrow(/Unsafe command/);
  });

  it('escapes help text and rejects unsafe function names', () => {
    const html = createHelp({
      name: '<b>M</b>',
      describe: 'a&b',
      api: [
        {
          title: '<t>',
          functionName: 'ok',
          params: [{ name: '<p>', desc: '"d"' }],
        },
      ],
    });

    expect(html).not.toContain('<b>M</b>');
    expect(html).toContain('&lt;b&gt;M&lt;/b&gt;');
    expect(html).toContain('a&amp;b');
    expect(html).toContain('&lt;t&gt;');
    expect(html).toContain('&lt;p&gt;');
    expect(html).toContain('&quot;d&quot;');

    expect(() =>
      createHelp({
        name: 'M',
        describe: 'd',
        api: [{ title: 't', functionName: "a'b" }],
      })
    ).toThrow(/Unsafe function name/);
  });

  it('keeps dom names unique across renders in the same tick', () => {
    const button = { content: 'go', command: 'cmd' };
    expect(formNameOf(createForm('dup', [], button))).not.toBe(
      formNameOf(createForm('dup', [], button))
    );

    const module = {
      name: 'M',
      describe: 'd',
      api: [{ title: 't', functionName: 'same' }],
    };
    const first = createHelp(module).match(/for="([^"]+)"/)![1];
    const second = createHelp(module).match(/for="([^"]+)"/)![1];
    expect(first).not.toBe(second);
  });
});
