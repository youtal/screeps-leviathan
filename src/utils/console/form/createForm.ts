/**
 * 文件摘要：把结构化表单描述渲染为可在 Screeps 控制台中显示和执行的 HTML。
 *
 * 模块位置：src/utils/console/form 的入口渲染器。它向下依赖同目录的 template.html、
 * style.html（由 Rollup 的 htmlString 插件在构建期压缩成字符串）与 types.ts 的控件描述，
 * 向上仅被 example.ts 引用，尚未经 console/index.ts 暴露为公共 API。
 *
 * 主要输入 / 输出：输入为表单名、控件描述数组（判别联合 HTMLElementDetail[]）与按钮参数
 * ButtonDetail；输出是单行 HTML 字符串（内联 style + form），可直接 console.log 到控制台。
 * 渲染过程是纯字符串拼接，不读写 Memory；唯一运行时依赖是 Game.time（用于表单 DOM 名）。
 *
 * 状态与副作用：模块求值期执行一次 template.split(';;')，把模板片段解构为模块级常量，
 * 属于跨 tick 复用、随 global reset 重建的预计算；createForm 本身无可变状态与缓存。
 * 拼接结果会经过 fixRetraction 折叠为单行，因此内嵌脚本必须写成单行安全的 JavaScript：
 * 不使用 `//` 行注释，并显式写出每条语句的分号（折叠后不再有换行可供自动分号插入）。
 */
import template from './template.html'
import style from './style.html'
import { replaceHtml, fixRetraction } from '../utils'
import { HTMLElementDetail, HTMLElements, HTMLCreator, ButtonDetail } from './types'

/**
 * 模板片段顺序必须与 template.html 中各 `;;` 分隔段保持一致。
 *
 * 这里依赖数组解构的位置对应关系：构建期 htmlString 插件已用 removeComments 去掉
 * 模板里的 HTML 注释（包括注释中出现的分隔符文本），因此运行时 split 得到的 7 段
 * 依次是表单外层、select、option、input、checkbox、radio、field 容器。
 * TypeScript 无法校验 split 结果的分段数量，模板增删分隔符时只能靠这段约定维持同步。
 */
const [formTemplate, selectTemplate, optionTemplate, inputTemplate,
    checkboxTemplate, radioTemplate, fieldTemplate] = template.split(';;')

/**
 * 各类表单控件的 HTML 构造器映射。
 *
 * mapped type 保证每个 HTMLElements 键都存在构造器，并使参数与该键对应的
 * 描述类型一致；新增控件时，类型系统会提示同步补充实现。
 * 相较 switch 分支，映射表的查找是 O(1)，且“新增枚举键后忘记实现”会直接变成编译错误。
 */
const creators: {
    [type in keyof HTMLElements]: (detail: HTMLElements[type]) => string
} = {
    /**
     * 创建文本输入框，并通过 field 模板统一添加标签容器。
     *
     * label/placeholder 的默认值把“未提供”归一化为空串，避免 undefined 被
     * 模板替换成字面量 "undefined"。
     * @param detail 输入框名称、标签和占位文本
     */
    input ({ name, label = '', placeholder = '' }: HTMLElements['input']): string {
        const content = replaceHtml(inputTemplate, { name, placeholder })
        return replaceHtml(fieldTemplate, { label, content })
    },

    /**
     * 创建下拉框；先渲染每个 option，再拼入 select 和 field 模板。
     *
     * 每个候选项自身带有 value/label 两个占位符，可直接作为 replaceHtml 的映射；
     * 选项之间用空串连接，因为每个 option 片段已经是完整标签。
     * @param detail 下拉框名称、标签和候选项
     */
    select ({ name, label = '', options }: HTMLElements['select']): string {
        const optionHtml = options.map(opt => replaceHtml(optionTemplate, opt))
        const content = replaceHtml(selectTemplate, { name, option: optionHtml.join('') })
        return replaceHtml(fieldTemplate, { label, content })
    },

    /**
     * 创建同名 radio 组；浏览器以相同 name 保证只能选择一项。
     *
     * 展开顺序为先 opt 后 name，因此同组控件的 name 一定由参数统一覆盖，
     * 不会受候选项字段影响。
     * @param detail 单选组名称、标签和候选项
     */
    radio ({ name, label = '', options }: HTMLElements['radio']): string {
        const content = options.map(opt => replaceHtml(radioTemplate, { ...opt, name })).join('')
        return replaceHtml(fieldTemplate, { label, content })
    },

    /**
     * 创建同名 checkbox 组；提交脚本会把所有选中值收集为数组。
     *
     * 与 radio 共用“同名分组”的思路，区别在于浏览器允许同时选中多个，
     * 因此按钮脚本对 checkbox 走 RadioNodeList 分支而不是直接取 value。
     * @param detail 复选组名称、标签和候选项
     */
    checkbox ({ name, label = '', options }: HTMLElements['checkbox']): string {
        const content = options.map(opt => replaceHtml(checkboxTemplate, { ...opt, name })).join('')
        return replaceHtml(fieldTemplate, { label, content })
    }
}

/**
 * 创建可交互的 Screeps 控制台表单。
 *
 * 表单名拼接 Game.time，以降低同一控制台中不同 tick 输出发生名称冲突的概率。
 * `command` 会被写入模板的按钮处理逻辑，调用方必须传入可在游戏控制台执行的
 * 命令字符串。
 *
 * 渲染顺序：生成表单 DOM 名 → 渲染控件与按钮参数 → 套用外层模板 → 折叠换行。
 * 表单名与字段名会被原样拼进 HTML 属性与内嵌脚本，因此约定只用不含引号、反斜杠
 * 和换行的普通文本；控件内容同样不做 HTML 转义，调用方需保证数据可信。
 * @param name 表单的名称
 * @param details 表单元素列表
 * @param buttonDetail 按钮的信息
 */
export const createForm = function (name: string, details: HTMLElementDetail[], buttonDetail: ButtonDetail): string {
    /**
     * 使用当前 tick 构造表单 DOM 名称，供模板内的 document.forms 查询。
     * 后缀让不同 tick 打印的同名表单在 DOM 中互不覆盖。
     */
    const formName = name + Game.time.toString()

    /**
     * 同时生成字段名列表、控件 HTML 和按钮参数，再一次性填充外层模板。
     *
     * elementNames 依赖 Array.prototype.toString 的逗号连接语义，模板会在其外层
     * 补上方括号，最终成为按钮脚本里的字段名数组字面量；控件为空时得到 `[]`。
     */
    const elementNames = details.map(({ name }) => `'${name}'`).toString()
    const { content: buttonLabel, command } = buttonDetail
    /**
     * 用判别字段 type 查表渲染。HTMLElementDetail 是判别联合，索引结果的类型是
     * 四个构造器函数类型的联合；TypeScript 无法调用“参数类型取交集的联合函数”，
     * 因此这里断言为 HTMLCreator，把安全性交回给 HTMLElements 映射的键值对应关系。
     */
    const formContent = details.map(detail => (creators[detail.type] as HTMLCreator)(detail)).join('')

    const formHtml = style + replaceHtml(formTemplate, {
        formName, formContent, elementNames, command, buttonLabel
    })

    /** 控制台按行渲染，最后统一折叠为单行；拼接的脚本因此必须单行安全（块注释 + 显式分号）。 */
    return fixRetraction(formHtml)
}
