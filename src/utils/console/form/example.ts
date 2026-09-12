/**
 * 文件摘要：提供覆盖全部表单控件的 createForm 使用示例。
 *
 * 模块位置：src/utils/console/form 下的开发期样例，与渲染器 createForm.ts、类型契约
 * types.ts 并列；它只被 console/index.ts 中预留的公共导出引用，当前不属于生产路径。
 *
 * 主要输入 / 输出：不接受参数，调用时把固定的控件描述交给 createForm，返回可直接
 * console.log 的 HTML 字符串。示例在被调用时读取 Game.time 并生成 HTML，可用于开发期
 * 检查 input、select、radio 与 checkbox 的渲染和命令参数传递方式。
 *
 * 状态与副作用：无模块级状态、无缓存、不访问 Memory；只有调用 getForm 时才会读取
 * Game.time 并拼接字符串，因此导入本文件不会产生任何副作用，可以安全地作为控制台
 * 调试入口按需调用。
 */
import { createForm } from './createForm';

/**
 * 创建一个包含所有可用控件的表单示例，返回值可直接输出到游戏控制台。
 *
 * 四个控件的 name 依次为 myInput/mySelect/myCheckbox/myRadio；提交时按钮脚本会按
 * 这些 name 组装数据对象，其中 myCheckbox 是数组（多选），其余是字符串。
 * 该函数只返回 HTML，不执行命令，也不修改任何游戏状态。
 */
export const getForm = function () {
  /**
   * 四个控件覆盖 input/select/checkbox/radio 四种描述形态：select、checkbox、radio
   * 都带 options，input 只带 placeholder。候选项 value 统一用字符串，因为按钮脚本
   * 从 DOM 读取的 value 天然是字符串，示例与真实提交结果保持一致。
   */
  return createForm(
    'form 示例',
    [
      {
        name: 'myInput',
        label: '输入框',
        type: 'input',
        placeholder: '这是一个输入框',
      },
      {
        name: 'mySelect',
        label: '下拉框',
        type: 'select',
        options: [
          { value: '0', label: '选项A' },
          { value: '1', label: '选项B' },
        ],
      },
      {
        name: 'myCheckbox',
        label: '复选框',
        type: 'checkbox',
        options: [
          { value: '0', label: '选项A' },
          { value: '1', label: '选项B' },
        ],
      },
      {
        name: 'myRadio',
        label: '单选框',
        type: 'radio',
        options: [
          { value: '0', label: '选项A' },
          { value: '1', label: '选项B' },
        ],
      },
    ],
    {
      content: '提交',
      /**
       * 下面这个函数会被发送到游戏控制台，接受的 data 参数就是输入的表单内容。
       *
       * 它以源码字符串形式保存：模板中的按钮脚本最终执行
       * `(<command>)(<表单数据 JSON>)`，因此这里写成单行箭头函数，返回一段
       * 展示用文本；字符串里的单引号通过 `\'` 转义，避免提前结束 JS 字面量。
       */
      command: "data => '你提交的数据为 ' + JSON.stringify(data)",
    }
  );
};
