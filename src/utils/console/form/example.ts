/**
 * 文件摘要
 *
 * 模块角色：utils/console/form 的调用示例，展示各类控件如何组织成一个表单。
 *
 * 主要功能：getForm 提供包含输入、下拉、多选和单选控件的示例 HTML。
 *
 * 实现过程：把固定控件描述和提交按钮命令传给 createForm，返回生成的字符串，供调用方自行打印。
 *
 * 技术要点：导入时不渲染，调用时由 createForm 读取 Game.time 生成表单名；没有状态缓存或存储访问。
 * 这是示例函数，尚未由 console 公共入口导出，提交命令随 HTML 中的按钮点击而执行。
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
