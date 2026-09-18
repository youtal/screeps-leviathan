/**
 * 文件摘要
 *
 * 模块角色：core/runtime 的公共入口，供 app、集成代码和测试创建基础运行环境。
 *
 * 主要功能：导出 createRuntime、createEnvMethods，以及装配选项和上下文相关类型。
 *
 * 实现过程：分别转发 Runtime 工厂、环境构造函数与 types.ts，让调用方按需要创建完整能力或环境对象。
 *
 * 技术要点：入口没有默认实例，导入本文件不启动游戏循环或读取存储。
 * 完整能力的创建顺序由 createRuntime 管理，业务模块通常直接接收 Framework 提供的上下文。
 */
export { createEnvMethods } from './env';
export { createRuntime } from './createRuntime';
/**
 * 类型统一走 `export *`：types.ts 只包含类型与接口，编译后不会留下代码，
 * 后续新增上下文类型也无须在这里重复登记。
 */
export * from './types';
