/**
 * 文件摘要：集中保存项目级默认开关，供日志系统和 Runtime 初始化使用。
 *
 * 这些值只提供默认行为；模块仍可在创建上下文时覆盖自己的日志等级。
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
 */

export const DEFAULT_PROFILER_ENABLE = false;

export const MAX_GROUP_EVENTBUS_TTL = 15000;
