/**
 * 文件摘要：声明控制台帮助渲染器接收的模块、函数和参数描述结构。
 *
 * 所有字段均为可序列化描述数据，不持有游戏对象；可选字段用于省略没有说明、
 * 参数或特殊调用形式的部分。
 */
/**
 * 单个模块的帮助元数据。
 */
export interface ModuleDescribe {
    /**
     * 模块名
     */
    name: string
    /**
     * 模块介绍
     */
    describe: string
    /**
     * 该模块的 api 列表
     */
    api: FunctionDescribe[]
}

/**
 * 单个函数或控制台命令的帮助元数据。
 */
export interface FunctionDescribe {
    /**
     * 函数的名字
     */
    title: string
    /**
     * 函数如何使用
     */
    describe?: string
    /**
     * 参数列表
     * 置空则没有参数
     */
    params?: {
        /**
         * 参数名
         */
        name: string
        /**
         * 参数介绍
         */
        desc: string
    }[]
    /**
     * 函数的方法名
     */
    functionName: string
    /**
     * 是否可以直接执行：不需要使用 () 就可以执行的命令
     */
    commandType?: boolean
}
