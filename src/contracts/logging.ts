/**
 * 文件摘要：发布日志输出、等级配置、输出端口与作用域工厂协议。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
 */
/** undefined 跟随默认开关，false 显式关闭；默认值取自项目设置，不规定具体格式或输出后端。 */
export interface LogOptions {
  debug?: boolean;
  warn?: boolean;
  error?: boolean;
  success?: boolean;
  info?: boolean;
  report?: boolean;
}
/** 同步输出端口；通知、前缀和颜色由装配及实现决定。 */
export interface Logger {
  debug(content: string): void;
  warn(content: string): void;
  error(content: string): void;
  success(content: string): void;
  info(content: string): void;
  report(content: string): void;
}

/**
 * 已完成格式化的单行文本输出端口。
 *
 * 两个通道都由实现自行吞掉异常：日志是观测设施，输出失败不得中断业务，
 * 也不得反向触发错误处理回路。
 */
export interface LogOutput {
  /** 控制台通道；默认实现写入 console.log。 */
  write(line: string): void;
  /** 邮件通道；默认实现调用 Game.notify，是否调用由等级与邮件策略共同决定。 */
  notify(line: string): void;
}

/**
 * 装配级日志配置，由 Runtime（或独立集成方）创建日志工厂时提供。
 *
 * 等级与邮件策略都在装配阶段确定一次，运行期不再读取配置；作用域只能按
 * ScopeLogOptions 做局部覆盖，避免同一进程内出现互相矛盾的全局开关。
 */
export interface LoggingOptions {
  /** 全局等级默认值；未提供的等级回退项目默认设置，作用域可逐字段覆盖。 */
  levels?: LogOptions;
  /** 装配级邮件策略：off 默认不发送，error 允许作用域按需开启 error 邮件。 */
  notify?: 'off' | 'error';
  /** 默认邮件端口调用 Game.notify 时的分组间隔（分钟），正整数，默认 60。 */
  notifyInterval?: number;
  /** 输出端口覆盖；未提供的通道使用默认实现，注入完整端口可实现静默或转存。 */
  output?: Partial<LogOutput>;
}

/** 单个作用域的局部覆盖；notify 覆盖装配级策略，undefined 表示跟随装配配置。 */
export interface ScopeLogOptions {
  levels?: LogOptions;
  notify?: boolean;
}

/**
 * 按作用域派生 Logger 的协议。
 *
 * Runtime 组装唯一实例，并把同一工厂注入模块环境与内核消费者（EventBus、
 * Profiler、ErrorMapper 等），使全项目共享一套输出端口与邮件策略；作用域名
 * 会成为日志前缀。该协议不承诺异步初始化、刷新或关闭能力。
 */
export interface LoggerFactory {
  scope(scopeName: string, options?: ScopeLogOptions): Logger;
}
