/**
 * 文件摘要：把模块和函数的结构化说明渲染为 Screeps 控制台帮助 HTML。
 *
 * 模板和样式以字符串导入，模块、API 和参数说明逐层渲染后合并。颜色工具只
 * 生成 span 标记；最终的 fixRetraction 移除换行，以适配游戏控制台输出。
 */
import template from './template.html';
import style from './style.html';
import {
  replaceHtml,
  fixRetraction,
  dyeYellow,
  dyeGreen,
  dyeBlue,
} from '../utils';
import { ModuleDescribe, FunctionDescribe } from './types';
console.log(`template: ${template}`); // 开发期输出原始模板，便于检查文本插件的导入结果。
/** 模板片段的解构顺序必须与 template.html 的 `;;` 分段保持一致。 */
const [
  moduleContainerTemplate,
  moduleTemplate,
  apiContainerTemplate,
  apiLineTemplate,
] = template.split(';;');

/**
 * 创建一个或多个模块的帮助信息，并套用统一样式与外层容器。
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
 * @param module 要创建的模块描述对象
 * @returns 模块帮助 html 文本
 */
const createModule = function (module: ModuleDescribe): string {
  return replaceHtml(moduleTemplate, {
    title: dyeYellow(module.name),
    describe: dyeGreen(module.describe),
    functionList: module.api.map(createApiHelp).join(''),
  });
};

/**
 * 绘制单个 api 的帮助元素
 *
 * @param func api 的描述信息
 * @returns 绘制完成的字符串
 */
const createApiHelp = function (func: FunctionDescribe): string {
  const contents: string[] = [];
  /** API 描述可选；存在时作为第一行内容。 */
  if (func.describe) contents.push(dyeGreen(func.describe));

  /** 参数列表逐项着色并转换为独立的帮助行。 */
  if (func.params) {
    /** 先生成纯内容，再统一套用 apiLineTemplate。 */
    const describes = func.params.map((param) => {
      return `  - ${dyeBlue(param.name)}: ${dyeGreen(param.desc)}`;
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
    ? func.params.map((param) => dyeBlue(param.name)).join(', ')
    : '';
  /** commandType 表示控制台属性式命令，因此省略函数调用括号。 */
  const funcCall =
    dyeYellow(func.functionName) + (func.commandType ? '' : `(${paramInFunc})`);

  /** 将调用示例追加到描述和参数说明之后。 */
  contents.push(funcCall);

  const content = contents
    .map((content) => replaceHtml(apiLineTemplate, { content }))
    .join('');
  const checkboxId = `${func.functionName}${Game.time}`;

  /** Game.time 参与折叠控件 id，降低多个 tick 的帮助面板发生 DOM 冲突的概率。 */
  return replaceHtml(apiContainerTemplate, {
    checkboxId,
    content,
    title: `${func.title} ${dyeYellow(func.functionName, true)}`,
  });
};
