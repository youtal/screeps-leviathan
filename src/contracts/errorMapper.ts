/**
 * 文件摘要：发布同步错误捕获、源码堆栈映射和诊断出口。
 * 属于 contracts 的编译期公共约定；只依赖其他契约或宿主类型，不导入具体实现。
 * 实现通过显式类型标注承诺结构，调用者通过 import type 引用；不创建状态或运行时副作用。
 */
/**
 * 诊断使用的执行位置；commit 是意图提交边界，framework 表示不属于插件的内核工作。
 * 该值同时是权限判据：订阅只允许在 setup，意图只允许在 tickExecute，Kernel 据此拒绝越权调用。
 */
export type Phase =
  | 'setup'
  | 'tickBegin'
  | 'tickExecute'
  | 'commit'
  | 'tickEnd'
  | 'dispose'
  | 'framework';

/** 单次调用的可序列化诊断；保留原始堆栈，在映射可用时额外附带源码位置。 */
export interface PluginFailure {
  tick: number;
  pluginId: string;
  phase: Phase;
  message: string;
  stack: string;
  mappedStack?: string;
  /** 为调用级 CPU 诊断预留；当前捕获器不填充，聚合耗时由 Profiler 保存。 */
  cpuUsed?: number;
}

/** ok 是判别字段；显式检查后 TypeScript 才能安全访问 value 或 failure。 */
export type ExecutionResult<T> =
  { ok: true; value: T } | { ok: false; failure: PluginFailure };
/** 泛型保留回调结果，计时设施不得改变业务返回值。 */
export type Measure = <T>(label: string, callback: () => T) => T;
export type FailureReporter = (failure: PluginFailure) => void;
/** 映射失败降级保留原栈；capture 拒绝 Promise，报告异常不得覆盖原故障。 */
export interface ErrorMapper {
  capture<T>(
    metadata: Pick<PluginFailure, 'tick' | 'pluginId' | 'phase'>,
    callback: () => T
  ): ExecutionResult<T>;
  mapStack(stack: string): string;
  setMeasure(wrapper: Measure): void;
}
