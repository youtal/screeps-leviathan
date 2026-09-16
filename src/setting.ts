/**
 * 文件摘要：集中保存项目级默认开关，供日志系统和 Runtime 初始化使用。
 *
 * 这些值只提供默认行为；模块仍可在创建上下文时覆盖自己的日志等级。
 * 本文件只声明常量，不读取 Game/Memory，也没有模块级副作用，因此可以被任意层导入。
 */

/**
 * 内核日志的默认等级开关：warning/error/report 默认开启，debug/success/info 关闭。
 *
 * core/logger 在装配日志工厂时用 `??` 逐字段回退到这里的值，作用域还能再用 LogOptions
 * 覆盖，因此模块显式传 false 也能生效；键名 warning 对应 LogOptions 的 warn，六个等级
 * （含 report）都遵循同一套回退规则。
 * 每个等级都会真实调用 console.log（error 还可在装配允许时触发 Game.notify），
 * 在热路径上输出大量 debug/info 会直接消耗 tick CPU 并刷屏，因此默认保持关闭。
 */
export const DEFAULT_LOG_CONFIG = {
  debug: false,
  warning: true,
  error: true,
  success: false,
  info: false,
  report: true,
};

/**
 * Profiler 默认关闭，避免开发者未显式开启时承担每次函数调用的 CPU 取样成本。
 *
 * Runtime 工厂（core/runtime/createRuntime）读取该值并创建共享 Profiler；Framework
 * 只消费 Runtime 中的实例，不维护第二份默认开关。
 */

export const DEFAULT_PROFILER_ENABLE = false;

/**
 * group 作用域事件在 heap 中的默认存活上限，单位 tick（15000）。
 *
 * 分组消息只服务当前编队/任务，如果长期驻留会持续占用 heap 并拖慢订阅查找，因此用
 * 该上限约束其生命周期。这里只声明上限值，过期语义与清理时机由消费方决定；截至本次
 * 注释对齐，src/ 中还没有引用该常量的代码，接入前不要假定事件总线会自动过期。
 */
export const MAX_GROUP_EVENTBUS_TTL = 15000;
