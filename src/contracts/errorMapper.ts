/**
 * 文件摘要
 *
 * 模块角色：contracts 中的同步错误处理协议，连接框架执行过程与堆栈映射实现。
 *
 * 主要功能：规定执行阶段、故障记录、成功或失败结果，以及捕获、映射和计时接入方法。
 *
 * 实现过程：capture 用泛型保留回调返回值，通过 ok 字段区分 value 与 failure；
 * mapStack 接收堆栈文本，setMeasure 接收保持回调返回类型的计时函数。
 *
 * 技术要点：PluginFailure 同时保留执行归属和原始堆栈，映射堆栈是可选补充。
 * 这里只声明接口；同步调用限制、映射失败处理和诊断输出由 ErrorMapper 实现。
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
