/**
 * 文件摘要：同步还原构建堆栈并提供不会覆盖原始错误的捕获边界。
 * trace-mapping 无需 Promise/WASM；解析器懒加载，最多缓存 64 条，捕获入口截断为 16KB。
 * 映射和日志故障均回退原始诊断，避免错误处理器递归抛错；缓存随 global reset 清空。
 */
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import type { ExecutionResult, PluginFailure } from './types';

/**
 * 创建同步故障边界，成功返回原值，失败返回诊断联合类型，调用者据此隔离插件。
 * loadMap 注入构建映射的读取方式，默认由 Screeps 模块系统加载上传的 main.js.map；
 * trace-mapping 提供同步位置查询，避免异步初始化/WASM 与单 tick 调用约定冲突。
 */
export const createErrorMapper = (
  loadMap: () => any = () => require('main.js.map'),
  report: (failure: PluginFailure) => void = (failure) =>
    console.log(
      '[Framework] ' +
        failure.pluginId +
        '/' +
        failure.phase +
        ': ' +
        (failure.mappedStack ?? failure.stack)
    )
) => {
  /** 每个实例仅尝试加载一次；失败后到 global reset 前退回原始堆栈，避免反复支付失败成本。 */
  let attempted = false;
  let map: TraceMap | undefined;
  /** 按原始堆栈缓存映射结果；插入序淘汰最早项，命中不移位，因此不是 LRU。 */
  const cache = new Map<string, string>();
  /** 初始直通；Kernel 在组合完成后注入计时函数，映射器本身不依赖 Profiler 实例。 */
  let measure = <T>(_label: string, callback: () => T): T => callback();
  /**
   * 只替换 main/main.js 的位置片段，无法定位的帧原样保留，不猜测外部库位置。
   * 正常命中仅需 Map 查询；未命中需扫描文本并逐帧查询 source map。
   * capture 会将输入截断到 16KB；直接调用此方法时调用者自行控制长度。
   */
  const mapStack = (stack: string): string => {
    if (cache.has(stack)) return cache.get(stack)!;
    try {
      if (!attempted) {
        attempted = true;
        map = measure(
          'framework.errorMapper.loadSourceMap',
          () => new TraceMap(loadMap())
        );
      }
      if (!map) return stack;
      // V8 堆栈列从 1 开始，source map 列从 0 开始；仅映射当前打包模块。
      const mapped = stack.replace(
        /\bmain(?:\.js)?:(\d+):(\d+)/g,
        (match, line, column) => {
          const pos = originalPositionFor(map!, {
            line: Number(line),
            column: Number(column) - 1,
          });
          return pos.source && pos.line !== null && pos.column !== null
            ? pos.source + ':' + pos.line + ':' + (pos.column + 1)
            : match;
        }
      );
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(stack, mapped);
      return mapped;
    } catch {
      return stack;
    }
  };
  /**
   * Pick 限定必需归属字段，泛型 T 将成功分支与业务返回值关联。
   * 同步钩子发现 thenable 就失败；消费 Promise 拒绝仅防止宿主额外报告，不能取消已启动任务。
   * 错误可能不是 Error，甚至 toString/stack getter 也可能抛错，故诊断构造分层降级。
   */
  const capture = <T>(
    metadata: Pick<PluginFailure, 'tick' | 'pluginId' | 'phase'>,
    callback: () => T
  ): ExecutionResult<T> => {
    try {
      const value = callback();
      if (value && typeof (value as any).then === 'function') {
        // 插件契约是同步的；消费拒绝避免测试/宿主产生未处理 Promise。
        Promise.resolve(value).catch(() => undefined);
        throw new Error('Framework hooks must be synchronous');
      }
      return { ok: true, value };
    } catch (error) {
      let message = 'Unprintable thrown value';
      let stack = message;
      try {
        message = String(error).slice(0, 16384);
        stack = (
          error instanceof Error ? (error.stack ?? message) : message
        ).slice(0, 16384);
      } catch {
        /* 恶意或损坏的 toString/getter 不能击穿故障边界。 */
      }
      const failure: PluginFailure = { ...metadata, message, stack };
      try {
        failure.mappedStack = measure('framework.errorMapper.mapStack', () =>
          mapStack(stack)
        );
      } catch {
        /* 统计或映射失效时保留原始堆栈。 */
      }
      try {
        measure('framework.errorMapper.report', () => report(failure));
      } catch {
        /* 日志故障不影响返回原始故障。 */
      }
      return { ok: false, failure };
    }
  };
  return {
    capture,
    mapStack,
    // typeof 保留通用计时函数的泛型签名；替换观测适配器不清空已解析的 map/堆栈缓存。
    setMeasure: (wrapper: typeof measure) => {
      measure = wrapper;
    },
  };
};
