/**
 * 文件摘要
 *
 * 模块角色：utils/console/form 的表单渲染实现，将控件描述转换为控制台可显示的 HTML。
 *
 * 主要功能：生成输入框、下拉框、单选框、多选框及带命令的提交按钮，返回单行表单字符串。
 *
 * 实现过程：模块加载时将模板按分隔符拆为七段，按 detail.type 选择构造函数并填充占位符，
 * 再组合表单外层、内联样式和按钮参数，删除换行后返回。
 *
 * 技术要点：映射类型要求每种控件都有构造函数；表单名由名称、Game.time 与渲染序号组成，
 * 同 tick 多次渲染也不会重名。标签、占位文本与选项按 HTML 转义，表单名、字段名与命令按
 * 标识符校验（信任边界见 docs/design/utils/console.md）。
 * 模板片段跨 tick 复用，global reset 后重建；不自动打印或提交命令，按钮行为由输出中的脚本在点击时执行。
 */
import template from './template.html';
import style from './style.html';
import {
  replaceHtml,
  fixRetraction,
  escapeHtml,
  assertScriptSafe,
} from '../utils';
import {
  HTMLElementDetail,
  HTMLElements,
  HTMLCreator,
  ButtonDetail,
} from './types';

/**
 * 模板片段顺序必须与 template.html 中各 `;;` 分隔段保持一致。
 *
 * 这里依赖数组解构的位置对应关系：构建期 htmlString 插件已用 removeComments 去掉
 * 模板里的 HTML 注释（包括注释中出现的分隔符文本），因此运行时 split 得到的 7 段
 * 依次是表单外层、select、option、input、checkbox、radio、field 容器。
 * TypeScript 无法校验 split 结果的分段数量，模板增删分隔符时只能靠这段约定维持同步。
 */
const [
  formTemplate,
  selectTemplate,
  optionTemplate,
  inputTemplate,
  checkboxTemplate,
  radioTemplate,
  fieldTemplate,
] = template.split(';;');

/**
 * 各类表单控件的 HTML 构造器映射。
 *
 * mapped type 保证每个 HTMLElements 键都存在构造器，并使参数与该键对应的
 * 描述类型一致；新增控件时，类型系统会提示同步补充实现。
 * 相较 switch 分支，映射表的查找是 O(1)，且“新增枚举键后忘记实现”会直接变成编译错误。
 */
const creators: {
  [type in keyof HTMLElements]: (detail: HTMLElements[type]) => string;
} = {
  /**
   * 创建文本输入框，并通过 field 模板统一添加标签容器。
   *
   * label/placeholder 的默认值把“未提供”归一化为空串，避免 undefined 被
   * 模板替换成字面量 "undefined"。
   * @param detail 输入框名称、标签和占位文本
   */
  input({ name, label = '', placeholder = '' }: HTMLElements['input']): string {
    const content = replaceHtml(inputTemplate, {
      name: assertScriptSafe('field name', name),
      placeholder: escapeHtml(placeholder),
    });
    return replaceHtml(fieldTemplate, { label: escapeHtml(label), content });
  },

  /**
   * 创建下拉框；先渲染每个 option，再拼入 select 和 field 模板。
   *
   * 每个候选项自身带有 value/label 两个占位符，可直接作为 replaceHtml 的映射；
   * 选项之间用空串连接，因为每个 option 片段已经是完整标签。
   * @param detail 下拉框名称、标签和候选项
   */
  select({ name, label = '', options }: HTMLElements['select']): string {
    const optionHtml = options.map((opt) =>
      replaceHtml(optionTemplate, {
        value: escapeHtml(opt.value),
        label: escapeHtml(opt.label),
      })
    );
    const content = replaceHtml(selectTemplate, {
      name: assertScriptSafe('field name', name),
      option: optionHtml.join(''),
    });
    return replaceHtml(fieldTemplate, { label: escapeHtml(label), content });
  },

  /**
   * 创建同名 radio 组；浏览器以相同 name 保证只能选择一项。
   *
   * 展开顺序为先 opt 后 name，因此同组控件的 name 一定由参数统一覆盖，
   * 不会受候选项字段影响。
   * @param detail 单选组名称、标签和候选项
   */
  radio({ name, label = '', options }: HTMLElements['radio']): string {
    const safeName = assertScriptSafe('field name', name);
    const content = options
      .map((opt) =>
        replaceHtml(radioTemplate, {
          value: escapeHtml(opt.value),
          label: escapeHtml(opt.label),
          name: safeName,
        })
      )
      .join('');
    return replaceHtml(fieldTemplate, { label: escapeHtml(label), content });
  },

  /**
   * 创建同名 checkbox 组；提交脚本会把所有选中值收集为数组。
   *
   * 与 radio 共用“同名分组”的思路，区别在于浏览器允许同时选中多个，
   * 因此按钮脚本对 checkbox 走 RadioNodeList 分支而不是直接取 value。
   * @param detail 复选组名称、标签和候选项
   */
  checkbox({ name, label = '', options }: HTMLElements['checkbox']): string {
    const safeName = assertScriptSafe('field name', name);
    const content = options
      .map((opt) =>
        replaceHtml(checkboxTemplate, {
          value: escapeHtml(opt.value),
          label: escapeHtml(opt.label),
          name: safeName,
        })
      )
      .join('');
    return replaceHtml(fieldTemplate, { label: escapeHtml(label), content });
  },
};

/**
 * 本 global 内的渲染序号，与 Game.time 一起构成表单的 DOM 名称。
 *
 * 只有 Game.time 时，同一 tick 渲染两个同名表单会得到相同的 DOM 名，按钮脚本按名查询
 * 会拿到先出现的那一个。序号从模块加载起单调递增，global reset 后重新计数；与 tick 组合
 * 后，只有“同 tick、同名、且中间发生过 reset”才可能重复，实际不会发生。
 */
let renderSeq = 0;

/**
 * 创建可交互的 Screeps 控制台表单。
 *
 * 表单名拼接 Game.time，以降低同一控制台中不同 tick 输出发生名称冲突的概率。
 * `command` 会被写入模板的按钮处理逻辑，调用方必须传入可在游戏控制台执行的
 * 命令字符串。
 *
 * 渲染顺序：生成表单 DOM 名 → 渲染控件与按钮参数 → 套用外层模板 → 折叠换行。
 * 表单名、字段名与命令会被原样拼进 HTML 属性与内嵌脚本，因此先用 assertScriptSafe 拒绝
 * 引号、尖括号、反引号、反斜杠、花括号与控制字符，不合法时立即抛错；标签、占位文本与
 * 选项的值与标签按 HTML 转义后写出。命令本身是代码，只能由开发者定义。
 * @param name 表单的名称
 * @param details 表单元素列表
 * @param buttonDetail 按钮的信息
 */
export const createForm = function (
  name: string,
  details: HTMLElementDetail[],
  buttonDetail: ButtonDetail
): string {
  /**
   * 使用当前 tick 构造表单 DOM 名称，供模板内的 document.forms 查询。
   * 后缀让不同 tick 打印的同名表单在 DOM 中互不覆盖。
   */
  const formName = `${assertScriptSafe('form name', name)}${Game.time}_${++renderSeq}`;

  /**
   * 同时生成字段名列表、控件 HTML 和按钮参数，再一次性填充外层模板。
   *
   * elementNames 依赖 Array.prototype.toString 的逗号连接语义，模板会在其外层
   * 补上方括号，最终成为按钮脚本里的字段名数组字面量；控件为空时得到 `[]`。
   */
  const elementNames = details
    .map(({ name }) => `'${assertScriptSafe('field name', name)}'`)
    .toString();
  const { content, command } = buttonDetail;
  /** 命令进入内嵌脚本的模板字符串，同样按标识符校验；按钮文字是纯文本，转义即可。 */
  assertScriptSafe('command', command);
  const buttonLabel = escapeHtml(content);
  /**
   * 用判别字段 type 查表渲染。HTMLElementDetail 是判别联合，索引结果的类型是
   * 四个构造器函数类型的联合；TypeScript 无法调用“参数类型取交集的联合函数”，
   * 因此这里断言为 HTMLCreator，把安全性交回给 HTMLElements 映射的键值对应关系。
   */
  const formContent = details
    .map((detail) => (creators[detail.type] as HTMLCreator)(detail))
    .join('');

  const formHtml =
    style +
    replaceHtml(formTemplate, {
      formName,
      formContent,
      elementNames,
      command,
      buttonLabel,
    });

  /** 控制台按行渲染，最后统一折叠为单行；拼接的脚本因此必须单行安全（块注释 + 显式分号）。 */
  return fixRetraction(formHtml);
};
