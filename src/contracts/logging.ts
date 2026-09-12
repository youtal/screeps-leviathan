/**
 * 文件摘要：发布日志输出及等级配置协议。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
 */
/** undefined 跟随默认开关，false 显式关闭；不规定具体格式或输出后端。 */
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
