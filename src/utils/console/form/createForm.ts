/**
 * 文件摘要：把结构化表单描述渲染为可在 Screeps 控制台中显示和执行的 HTML。
 *
 * HTML 与样式通过 Rollup 文本插件导入；模板以 `;;` 分段，再由元素构造器按
 * 判别字段 `type` 选择渲染方式。最后移除换行，避免控制台缩进破坏内嵌脚本。
 */
import template from './template.html'
import style from './style.html'
import { replaceHtml, fixRetraction } from '../utils'
import { HTMLElementDetail, HTMLElements, HTMLCreator, ButtonDetail } from './types'

/** 模板片段顺序必须与 template.html 中各 `;;` 分隔段保持一致。 */
const [formTemplate, selectTemplate, optionTemplate, inputTemplate,
    checkboxTemplate, radioTemplate, fieldTemplate] = template.split(';;')

/**
 * 各类表单控件的 HTML 构造器映射。
 *
 * mapped type 保证每个 HTMLElements 键都存在构造器，并使参数与该键对应的
 * 描述类型一致；新增控件时，类型系统会提示同步补充实现。
 */
const creators: {
    [type in keyof HTMLElements]: (detail: HTMLElements[type]) => string
} = {
    /**
     * 创建文本输入框，并通过 field 模板统一添加标签容器。
     * @param detail 输入框名称、标签和占位文本
     */
    input ({ name, label = '', placeholder = '' }: HTMLElements['input']): string {
        const content = replaceHtml(inputTemplate, { name, placeholder })
        return replaceHtml(fieldTemplate, { label, content })
    },

    /**
     * 创建下拉框；先渲染每个 option，再拼入 select 和 field 模板。
     * @param detail 下拉框名称、标签和候选项
     */
    select ({ name, label = '', options }: HTMLElements['select']): string {
        const optionHtml = options.map(opt => replaceHtml(optionTemplate, opt))
        const content = replaceHtml(selectTemplate, { name, option: optionHtml.join('') })
        return replaceHtml(fieldTemplate, { label, content })
    },

    /**
     * 创建同名 radio 组；浏览器以相同 name 保证只能选择一项。
     * @param detail 单选组名称、标签和候选项
     */
    radio ({ name, label = '', options }: HTMLElements['radio']): string {
        const content = options.map(opt => replaceHtml(radioTemplate, { ...opt, name })).join('')
        return replaceHtml(fieldTemplate, { label, content })
    },

    /**
     * 创建同名 checkbox 组；提交脚本会把所有选中值收集为数组。
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
 * @param name 表单的名称
 * @param details 表单元素列表
 * @param buttonDetail 按钮的信息
 */
export const createForm = function (name: string, details: HTMLElementDetail[], buttonDetail: ButtonDetail): string {
    /** 使用当前 tick 构造表单 DOM 名称，供模板内的 document.forms 查询。 */
    const formName = name + Game.time.toString()

    /** 同时生成字段名列表、控件 HTML 和按钮参数，再一次性填充外层模板。 */
    const elementNames = details.map(({ name }) => `'${name}'`).toString()
    const { content: buttonLabel, command } = buttonDetail
    const formContent = details.map(detail => (creators[detail.type] as HTMLCreator)(detail)).join('')

    const formHtml = style + replaceHtml(formTemplate, {
        formName, formContent, elementNames, command, buttonLabel
    })

    return fixRetraction(formHtml)
}
