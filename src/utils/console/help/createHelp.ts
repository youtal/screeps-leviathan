/**
 * 文件摘要
 *
 * 模块角色：utils/console/help 的帮助渲染实现，将模块和函数说明组合成控制台面板。
 *
 * 主要功能：显示模块介绍、函数标题、参数解释和调用示例，返回带折叠结构的单行 HTML。
 *
 * 实现过程：加载时拆出四个模板片段，按模块、函数、内容行逐层填充并着色，
 * 用函数名加 Game.time 生成折叠控件 ID，最后加入样式并去掉换行。
 *
 * 技术要点：模板片段跨 tick 复用，global reset 后重建；折叠控件 ID 由函数名、Game.time 与
 * 渲染序号组成，同 tick 渲染同名函数也不会重复。模块名、介绍、标题与参数说明按 HTML 转义，
 * 函数名按标识符校验（信任边界见 docs/design/utils/console.md）。
 * 函数只返回文本，不打印、不执行示例命令，也不缓存渲染结果。
 */
import template from './template.html';
import style from './style.html';
import {
  replaceHtml,
  fixRetraction,
  dyeYellow,
  dyeGreen,
  dyeBlue,
  escapeHtml,
  assertScriptSafe,
} from '../utils';
import { ModuleDescribe, FunctionDescribe } from './types';

/**
 * 模板片段的解构顺序必须与 template.html 的 `;;` 分段保持一致。
 *
 * 4 段依次是：模块帮助容器、单个模块区块、API 折叠容器、API 内容行。
 * 构建期 html-minifier 已用 removeComments 去掉模板注释，因此运行时的分隔符
 * 只出现在真实片段之间；TypeScript 无法校验 split 的分段数量，增删片段时需自行同步。
 */
const [
  moduleContainerTemplate,
  moduleTemplate,
  apiContainerTemplate,
  apiLineTemplate,
] = template.split(';;');

/**
 * 本 global 内的渲染序号，与 Game.time 一起构成折叠控件的 DOM id。
 * 只有 Game.time 时，同一 tick 渲染两次同名 API 会得到相同 id，label 的 for 会指向先出现
 * 的那一个，点击其中一个会展开另一个。序号从模块加载起单调递增，global reset 后重新计数。
 */
let renderSeq = 0;

/**
 * 创建一个或多个模块的帮助信息，并套用统一样式与外层容器。
 *
 * 入参使用剩余参数，调用方可以一次打印多个模块；各模块区块用空串拼接，
 * 样式表只拼接一次。返回值必须是单行文本，因此最后统一折叠换行。
 * 帮助面板的展开/收起完全由模板中的 checkbox + label 与 CSS 实现，不含内联脚本。
 *
 * @param modules 模块的描述
 */
export const createHelp = function (...modules: ModuleDescribe[]): string {
  const content = modules.map(createModule).join('');
  const helpHtml = style + replaceHtml(moduleContainerTemplate, { content });

  return fixRetraction(helpHtml);
};

/**
 * 创建模块帮助
 *
 * 名称与介绍分别着色后填入模块模板；api 列表逐项交给 createApiHelp 渲染，
 * 这里不关心单个 API 的内部结构。
 *
 * @param module 要创建的模块描述对象
 * @returns 模块帮助 html 文本
 */
const createModule = function (module: ModuleDescribe): string {
  return replaceHtml(moduleTemplate, {
    title: dyeYellow(escapeHtml(module.name)),
    describe: dyeGreen(escapeHtml(module.describe)),
    functionList: module.api.map(createApiHelp).join(''),
  });
};

/**
 * 绘制单个 api 的帮助元素
 *
 * 渲染顺序：可选描述行 → 参数行 → 调用示例行，全部收集到 contents 后统一套用
 * 行模板并合并，再填入带折叠控件的 API 容器。
 *
 * 注意参数行被套了两层行模板：收集阶段已经把每条参数包进 apiLineTemplate，
 * 末尾的统一 map 会再包一次（描述行与调用行只包一次）。这是当前实现的既有行为，
 * 视觉上表现为参数行多一层同名的内边距容器；如需调整应连同模板一起改。
 *
 * checkboxId 由函数名、Game.time 与渲染序号拼成，同时用于 label 的 for 与 input 的 id：
 * 借助原生 checkbox 的选中态驱动 CSS 展开，无需脚本；tick 与序号一起保证不同 tick、
 * 以及同一 tick 内多次渲染的同名 API 都不会在 DOM 中互相串扰。
 *
 * @param func api 的描述信息
 * @returns 绘制完成的字符串
 */
const createApiHelp = function (func: FunctionDescribe): string {
  /** contents 保存尚未套用行模板的内容片段，顺序即最终的显示顺序。 */
  const contents: string[] = [];
  /** 函数名进入折叠控件的 id 与 for 属性，并作为调用示例文本，按标识符校验。 */
  const functionName = assertScriptSafe('function name', func.functionName);
  /** API 描述可选；存在时作为第一行内容。 */
  if (func.describe) contents.push(dyeGreen(escapeHtml(func.describe)));

  /** 参数列表逐项着色并转换为独立的帮助行。 */
  if (func.params) {
    /** 先生成纯内容，再统一套用 apiLineTemplate；`  - ` 前缀提供视觉缩进。 */
    const describes = func.params.map((param) => {
      return `  - ${dyeBlue(escapeHtml(param.name))}: ${dyeGreen(escapeHtml(param.desc))}`;
    });

    /** 每条参数说明转换成模板片段后拼接。 */
    contents.push(
      describes
        .map((content) => {
          return replaceHtml(apiLineTemplate, { content });
        })
        .join('')
    );
  }

  /** 普通函数展示调用括号和参数；命令型入口只展示可直接执行的名称。 */
  const paramInFunc = func.params
    ? func.params.map((param) => dyeBlue(escapeHtml(param.name))).join(', ')
    : '';
  /**
   * commandType 表示控制台属性式命令，因此省略函数调用括号。
   * 无参数且非命令型时 paramInFunc 为空串，仍保留空括号，与真实调用形式一致。
   */
  const funcCall =
    dyeYellow(functionName) + (func.commandType ? '' : `(${paramInFunc})`);

  /** 将调用示例追加到描述和参数说明之后。 */
  contents.push(funcCall);

  /** 统一套用行模板：描述行与调用行包一层，参数行在此被第二次包装（见函数说明）。 */
  const content = contents
    .map((content) => replaceHtml(apiLineTemplate, { content }))
    .join('');
  const checkboxId = `${functionName}${Game.time}_${++renderSeq}`;

  /**
   * Game.time 参与折叠控件 id，降低多个 tick 的帮助面板发生 DOM 冲突的概率。
   * 标题由简短 title 与加粗的函数名组成，便于在折叠状态下识别入口。
   */
  return replaceHtml(apiContainerTemplate, {
    checkboxId,
    content,
    title: `${escapeHtml(func.title)} ${dyeYellow(functionName, true)}`,
  });
};
