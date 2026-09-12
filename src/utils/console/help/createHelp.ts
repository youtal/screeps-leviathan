/**
 * 文件摘要：把模块和函数的结构化说明渲染为 Screeps 控制台帮助 HTML。
 *
 * 模块位置：src/utils/console/help 的入口渲染器，依赖同目录的 template.html/style.html
 * （构建期由 Rollup 的 htmlString 插件压缩为字符串）与 types.ts 的描述类型；
 * 目前尚未在 console/index.ts 中导出，属于预留的公共能力。
 *
 * 主要输入 / 输出：输入是一个或多个 ModuleDescribe（模块名、介绍、FunctionDescribe 列表），
 * 输出是可直接 console.log 的单行 HTML 字符串。渲染是纯字符串拼接，不读写 Memory。
 *
 * 状态与副作用：模块求值期只执行一次 template.split(';;') 得到 4 个模板片段常量（跨 tick 复用、
 * global reset 后重建），不写任何输出，渲染结果由调用方自行 console.log；渲染函数本身无缓存、
 * 无可变状态，因此导入本模块不会产生导入期副作用。
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
    title: dyeYellow(module.name),
    describe: dyeGreen(module.describe),
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
 * checkboxId 由函数名与 Game.time 拼成，同时用于 label 的 for 与 input 的 id：
 * 借助原生 checkbox 的选中态驱动 CSS 展开，无需脚本；加入 tick 可避免不同 tick
 * 打印的同名 API 在 DOM 中互相串扰。
 *
 * @param func api 的描述信息
 * @returns 绘制完成的字符串
 */
const createApiHelp = function (func: FunctionDescribe): string {
  /** contents 保存尚未套用行模板的内容片段，顺序即最终的显示顺序。 */
  const contents: string[] = [];
  /** API 描述可选；存在时作为第一行内容。 */
  if (func.describe) contents.push(dyeGreen(func.describe));

  /** 参数列表逐项着色并转换为独立的帮助行。 */
  if (func.params) {
    /** 先生成纯内容，再统一套用 apiLineTemplate；`  - ` 前缀提供视觉缩进。 */
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
  /**
   * commandType 表示控制台属性式命令，因此省略函数调用括号。
   * 无参数且非命令型时 paramInFunc 为空串，仍保留空括号，与真实调用形式一致。
   */
  const funcCall =
    dyeYellow(func.functionName) + (func.commandType ? '' : `(${paramInFunc})`);

  /** 将调用示例追加到描述和参数说明之后。 */
  contents.push(funcCall);

  /** 统一套用行模板：描述行与调用行包一层，参数行在此被第二次包装（见函数说明）。 */
  const content = contents
    .map((content) => replaceHtml(apiLineTemplate, { content }))
    .join('');
  const checkboxId = `${func.functionName}${Game.time}`;

  /**
   * Game.time 参与折叠控件 id，降低多个 tick 的帮助面板发生 DOM 冲突的概率。
   * 标题由简短 title 与加粗的函数名组成，便于在折叠状态下识别入口。
   */
  return replaceHtml(apiContainerTemplate, {
    checkboxId,
    content,
    title: `${func.title} ${dyeYellow(func.functionName, true)}`,
  });
};
