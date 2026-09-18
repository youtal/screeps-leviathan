/**
 * 文件摘要
 *
 * 模块角色：utils/console/form 的输入类型定义，约束调用方提供的表单数据和渲染器构造函数。
 *
 * 主要功能：声明四类控件、选项、按钮文字与命令，以及控件联合类型和 HTMLCreator 函数类型。
 *
 * 实现过程：各控件用 type 字面量区分，HTMLElements 将名称关联到具体描述，
 * 再通过 HTMLElements[keyof HTMLElements] 生成联合，供渲染器按类型分派。
 *
 * 技术要点：新增控件需同步类型表和构造函数表；ButtonDetail.command 是待嵌入的命令字符串。
 * 这些声明只参与编译检查，不校验运行时内容、不创建 DOM，也不执行命令。
 */
/**
 * 所有表单控件共享的基础描述。
 */
interface ElementDetail {
  /**
   * 控件的 name 属性，也是提交结果对象中的键。
   *
   * 同一表单内重名会让按钮脚本只取到其中一个值（checkbox 例外，见模板中的
   * RadioNodeList 分支），因此约定同一表单内 name 唯一。
   */
  name: string;
  /**
   * 显示在控件前方的可选标签。
   */
  label?: string;
  /**
   * 判别字段；具体接口会把它收窄为固定字符串字面量。
   */
  type: string;
}

/**
 * 所有合法控件描述的联合类型。
 *
 * 通过 keyof 索引映射派生，而不是手写 `A | B | C`：新增控件登记到 HTMLElements 后
 * 联合自动扩展，不会出现映射表已更新、联合却漏项的漂移。
 */
export type HTMLElementDetail = HTMLElements[keyof HTMLElements];

/**
 * 输入框
 *
 * `type: 'input'` 是对基础接口 `type: string` 的收窄：接口继承允许用字面量类型
 * 覆盖更宽的同名字段，联合类型在判断 `detail.type` 时才能完成类型收窄。
 */
interface InputDetail extends ElementDetail {
  /**
   * 提示内容
   *
   * 对应 input 模板的 placeholder 占位符；省略时 createForm 用空串填充。
   */
  placeholder?: string;
  type: 'input';
}

/**
 * 下拉框
 *
 * options 与下面 radio/checkbox 的结构目前相同（value/label），但各自独立声明：
 * 三者语义不同，后续可能分化；修改其中一处时需要同步其余两处与模板占位符。
 */
interface SelectDetail extends ElementDetail {
  /**
   * 下拉框待选项
   */
  options: {
    /**
     * 选项值
     */
    value: string;
    /**
     * 选项显示内容
     */
    label: string;
  }[];
  type: 'select';
}

/**
 * 单选框
 *
 * 同组控件共用 name，由浏览器保证互斥选中，因此候选项只需 value/label。
 */
interface RadioDetail extends ElementDetail {
  /**
   * 待选项
   */
  options: {
    /**
     * 选项值
     */
    value: string;
    /**
     * 选项显示内容
     */
    label: string;
  }[];
  type: 'radio';
}

/**
 * 复选框
 *
 * 结构同 radio，差别在浏览器允许多选；按钮脚本会按 RadioNodeList 分支
 * 把所有选中值收集成数组再提交。
 */
interface CheckboxDetail extends ElementDetail {
  /**
   * 待选项
   */
  options: {
    /**
     * 选项值
     */
    value: string;
    /**
     * 选项显示内容
     */
    label: string;
  }[];
  type: 'checkbox';
}

/**
 * 按钮
 */
export interface ButtonDetail {
  /**
   * 按钮显示文本
   */
  content: string;
  /**
   * 按钮会执行的命令（可以访问游戏对象）
   *
   * 它是写入 onclick 的 JavaScript 源码字符串，而非命令名：模板会把它包成
   * `(<command>)(<表单数据 JSON>)` 后交给控制台执行，因此字符串必须能被控制台
   * 解析，并接受一个表单数据对象参数；内容需可信且不含换行（输出会折叠为单行）。
   */
  command: string;
}

/**
 * 控件种类到具体描述接口的映射。
 *
 * 该映射同时充当“控件种类”的登记表：键名与各接口的 type 字面量保持一致是维护约定，
 * TypeScript 无法自动校验二者相等，新增控件时需同时改键名与字面量。
 */
export interface HTMLElements {
  input: InputDetail;
  select: SelectDetail;
  checkbox: CheckboxDetail;
  radio: RadioDetail;
}

/**
 * 通用 HTML 构造器签名；输入是任一合法控件描述，输出是 HTML 字符串。
 *
 * 参数类型取联合而非 unknown/base 接口，使构造器实现必须在函数内部自行收窄；
 * createForm 中 `creators[detail.type]` 得到的是“函数类型的联合”，无法直接调用，
 * 因此断言为该签名——它接受任一控件描述，正好覆盖查表结果。
 */
export type HTMLCreator = (detail: HTMLElements[keyof HTMLElements]) => string;
