/**
 * 文件摘要：声明控制台表单的控件描述、按钮参数和构造器类型。
 *
 * 每种控件以 `type` 字符串作为判别字段，HTMLElementDetail 因而形成判别联合；
 * createForm 可以据此选择对应构造器，调用方也能获得精确的字段检查。
 */
/**
 * 所有表单控件共享的基础描述。
 */
interface ElementDetail {
    /**
     * 控件的 name 属性，也是提交结果对象中的键。
     */
    name: string
    /**
     * 显示在控件前方的可选标签。
     */
    label?: string
    /**
     * 判别字段；具体接口会把它收窄为固定字符串字面量。
     */
    type: string
}

/**
 * 所有合法控件描述的联合类型。
 */
export type HTMLElementDetail = HTMLElements[keyof HTMLElements]

/**
 * 输入框
 */
interface InputDetail extends ElementDetail {
    /**
     * 提示内容
     */
    placeholder?: string
    type: 'input'
}

/**
 * 下拉框
 */
 interface SelectDetail extends ElementDetail {
    /**
     * 下拉框待选项
     */
    options: {
        /**
         * 选项值
         */
        value: string
        /**
         * 选项显示内容
         */
        label: string
    }[]
    type: 'select'
}

/**
 * 单选框
 */
 interface RadioDetail extends ElementDetail {
    /**
     * 待选项
     */
    options: {
        /**
         * 选项值
         */
        value: string
        /**
         * 选项显示内容
         */
        label: string
    }[]
    type: 'radio'
}

/**
 * 复选框
 */
 interface CheckboxDetail extends ElementDetail {
    /**
     * 待选项
     */
    options: {
        /**
         * 选项值
         */
        value: string
        /**
         * 选项显示内容
         */
        label: string
    }[]
    type: 'checkbox'
}

/**
 * 按钮
 */
export interface ButtonDetail {
    /**
     * 按钮显示文本
     */
    content: string
    /**
     * 按钮会执行的命令（可以访问游戏对象）
     */
    command: string
}

/**
 * 控件种类到具体描述接口的映射。
 */
export interface HTMLElements {
    input: InputDetail
    select: SelectDetail
    checkbox: CheckboxDetail
    radio: RadioDetail
}

/**
 * 通用 HTML 构造器签名；输入是任一合法控件描述，输出是 HTML 字符串。
 */
export type HTMLCreator = (detail: HTMLElements[keyof HTMLElements]) => string
