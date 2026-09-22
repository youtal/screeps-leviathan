/**
 * 文件摘要
 *
 * 模块角色：core/errorMapper 的具体实现，为框架提供同步执行的错误捕获与源码定位。
 *
 * 主要功能：定义 ErrorMapperOptions，执行回调并返回成功或故障结果，映射源码堆栈并输出诊断。
 *
 * 实现过程：capture 捕获异常并整理归属与堆栈；mapStack 首次使用时加载 source map，
 * 借助 @jridgewell/trace-mapping 查询 main/main.js 的位置，再交给报告回调或注入的日志器。
 *
 * 技术要点：拒绝异步返回；捕获入口将消息和堆栈各截到 16KB，映射缓存最多保留 64 条，按插入顺序淘汰。
 * 加载每实例只尝试一次，映射或报告故障不覆盖原始错误；解析器和缓存跨 tick 复用，global reset 后重建。
 * 默认日志出口按（插件、阶段）去重：同一消息连续失败只记录一次，该插件在该阶段成功一次后重置；
 * 注入的 report 回调不去重，每次故障都会收到。
 */
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import type {
  ExecutionResult,
  LoggerFactory,
  PluginFailure,
} from '@/contracts';

/** ErrorMapper 自身拥有的配置；LoggerFactory 是前序依赖，由 Runtime 单独注入。 */
export interface ErrorMapperOptions {
  /** 首次映射请求时同步取得 source map；省略时加载构建产物的 main.js.map。 */
  loadSourceMap?: () => any;
  /**
   * 结构化故障出口；省略时使用 ErrorMapper 作用域的 error 日志（按插件与阶段去重）。
   * 注入的回调每次故障都会被调用，去重与限流由回调自行决定。
   */
  report?: (failure: PluginFailure) => void;
}

/**
 * 创建同步故障边界，成功返回原值，失败返回诊断联合类型，调用者据此隔离插件。
 * logging 必须由 Runtime 或测试组合边界显式注入；options.loadSourceMap 配置构建
 * 映射的读取方式，默认由 Screeps 模块系统加载上传的 main.js.map；
 * trace-mapping 提供同步位置查询，避免异步初始化/WASM 与单 tick 调用约定冲突。
 * 默认加载器在创建时选定，只有首次映射时才真正 require：模块导入与正常 tick
 * 都不支付读取成本，本地/测试环境也不会因为缺少 main.js.map 而加载失败。
 * loadMap 返回 any：TraceMap 接受原始 JSON 文本或已解析对象，由构造函数在运行时校验，
 * ErrorMapperOptions.loadSourceMap 不要求调用方依赖第三方的映射类型。
 *
 * report 缺省时使用注入日志工厂的 ErrorMapper 作用域输出：Screeps 中 console 输出
 * 有 CPU 与配额成本，生产环境可注入更省的实现；report 抛错会被吞掉，不会盖掉原始
 * 故障。日志能力不依赖映射器本身，因此这里不会形成"记录错误又触发错误"的回环。
 */
export const createErrorMapper = (
  logging: LoggerFactory,
  options: ErrorMapperOptions = {}
): import('@/contracts/errorMapper').ErrorMapper => {
  const loadMap = options.loadSourceMap ?? (() => require('main.js.map'));
  /**
   * 失败报告出口：显式注入优先，否则按 ErrorMapper 作用域记录 error 级日志。
   * 作用域日志器在创建映射器时派生一次并复用：作用域名、等级与着色前缀都不随
   * 单次故障变化，故障集中爆发时不应反复创建日志器对象与临时字符串。
   * 文本保持"插件/阶段: 堆栈"结构，映射成功时用映射后的堆栈；堆栈中的换行原样
   * 保留，错误日志允许多行（内容约定见 Logger 设计）。
   */
  const log = logging.scope('ErrorMapper');
  /**
   * 默认出口的去重表（“插件\u0000阶段” → 最近一次已记录的消息）。
   *
   * Core 架构 §10 要求“一次事件一次”：持续存在的故障（例如存储装载失败每 tick 都让
   * begin 抛错、被缓存的申请失败）若每次都记 error，会逐 tick 刷屏，开启邮件时每 tick
   * 调用 Game.notify。这里只在首次出现与消息变化时记录；同一键成功一次即删除记录，故障
   * 复发时重新记录。键粒度是插件与阶段，同阶段内的不同操作（例如框架自身的多个步骤）
   * 共享一个键，某一步成功会提前重置，最多导致一次重复记录。只驻留 heap，global reset 后
   * 清空；表大小受插件数 × 阶段数限制。结构化的 PluginFailure 仍每次返回给调用方。
   */
  const lastReported = new Map<string, string>();
  const reportKey = (
    metadata: Pick<PluginFailure, 'pluginId' | 'phase'>
  ): string => metadata.pluginId + '\u0000' + metadata.phase;
  const reportFailure =
    options.report ??
    ((failure: PluginFailure) => {
      const key = reportKey(failure);
      if (lastReported.get(key) === failure.message) return;
      lastReported.set(key, failure.message);
      log.error(
        failure.pluginId +
          '/' +
          failure.phase +
          ': ' +
          (failure.mappedStack ?? failure.stack)
      );
    });
  /** 每个实例仅尝试加载一次；失败后到 global reset 前退回原始堆栈，避免反复支付失败成本。 */
  let attempted = false;
  // 加载成功后一直复用同一个 TraceMap；undefined 表示不可用（尚未加载或加载失败）。
  let map: TraceMap | undefined;
  /** 按原始堆栈缓存映射结果；插入序淘汰最早项，命中不移位，因此不是 LRU。 */
  // capture 已把堆栈截断到 16KB，因此单条键值都有上限，缓存总占用约为 64 × 2 × 16KB。
  // 热条目被后来的新堆栈挤掉是有意取舍：异常通常成批重复出现，容量换的是防无界增长。
  const cache = new Map<string, string>();
  /** 初始直通；Kernel 在组合完成后注入计时函数，映射器本身不依赖 Profiler 实例。 */
  let measure = <T>(_label: string, callback: () => T): T => callback();
  /**
   * 只替换 main/main.js 的位置片段，无法定位的帧原样保留，不猜测外部库位置。
   * 正常命中仅需 Map 查询；未命中需扫描文本并逐帧查询 source map。
   * capture 会将输入截断到 16KB；直接调用此方法时调用者自行控制长度。
   */
  const mapStack = (stack: string): string => {
    // 非空断言：has 已保证键存在，但 TypeScript 不会跨两次 Map 调用保持收窄结论。
    if (cache.has(stack)) return cache.get(stack)!;
    try {
      if (!attempted) {
        attempted = true;
        map = measure(
          'framework.errorMapper.loadSourceMap',
          () => new TraceMap(loadMap())
        );
      }
      // 加载抛错时 map 仍未赋值：往后所有调用直接返回原始堆栈，不再重试也不缓存失败。
      if (!map) return stack;
      // V8 堆栈列从 1 开始，source map 列从 0 开始；仅映射当前打包模块。
      // 正则同时匹配 main:line:col 与 main.js:line:col，命中后逐帧查询 source map。
      const mapped = stack.replace(
        /\bmain(?:\.js)?:(\d+):(\d+)/g,
        (match, line, column) => {
          // map 在闭包外是可变绑定（let），上面的一次判空无法收窄进回调，故用 ! 断言。
          const pos = originalPositionFor(map!, {
            line: Number(line),
            column: Number(column) - 1,
          });
          // 未映射帧的 source/line/column 为 null，此时保留原始匹配文本而不是猜测位置。
          return pos.source && pos.line !== null && pos.column !== null
            ? pos.source + ':' + pos.line + ':' + (pos.column + 1)
            : match;
        }
      );
      // 只在成功映射后写缓存并淘汰最旧一项，容量恰好为 64，失败路径不会污染缓存。
      if (cache.size >= 64) {
        // Map 按插入顺序迭代，第一个键即最旧项；非空时一定存在，判断只为满足严格类型。
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(stack, mapped);
      return mapped;
    } catch {
      // 加载、构造或逐帧查询任一环节抛错都退回原始堆栈，诊断可用性优先于映射精度。
      return stack;
    }
  };
  /**
   * Pick 限定必需归属字段，泛型 T 将成功分支与业务返回值关联。
   * 同步钩子发现 thenable 就失败；消费 Promise 拒绝仅防止宿主额外报告，不能取消已启动任务。
   * 错误可能不是 Error，甚至 toString/stack getter 也可能抛错，故诊断构造分层降级。
   * metadata 只取 tick/pluginId/phase，message/stack/mappedStack 由此处填充，调用者无法伪造。
   */
  const capture = <T>(
    metadata: Pick<PluginFailure, 'tick' | 'pluginId' | 'phase'>,
    callback: () => T
  ): ExecutionResult<T> => {
    try {
      const value = callback();
      // T 可能是原始值，读取 .then 需要 any 断言；真值判断同时排除 null/undefined。
      if (value && typeof (value as any).then === 'function') {
        // 插件契约是同步的；消费拒绝避免测试/宿主产生未处理 Promise。
        // 已经启动的异步任务无法取消，这里只是不让它的拒绝逃逸到宿主。
        Promise.resolve(value).catch(() => undefined);
        throw new Error('Framework hooks must be synchronous');
      }
      // 成功即视为该插件在该阶段恢复，重置默认出口的去重记录；没有未决故障时只做一次长度判断。
      if (lastReported.size !== 0) lastReported.delete(reportKey(metadata));
      return { ok: true, value };
    } catch (error) {
      // 占位文本保证即使下面的规范化全部失败，也能返回一条可读诊断。
      let message = 'Unprintable thrown value';
      let stack = message;
      try {
        // 16KB 是诊断成本上限：堆栈同时用作映射缓存键，过长文本会放大比较与映射开销。
        message = String(error).slice(0, 16384);
        stack = (
          error instanceof Error ? (error.stack ?? message) : message
        ).slice(0, 16384);
      } catch {
        /* 恶意或损坏的 toString/getter 不能击穿故障边界。 */
      }
      const failure: PluginFailure = { ...metadata, message, stack };
      try {
        // mappedStack 只是附加信息：映射失败时保留原始 stack，调用方仍能定位插件阶段。
        // 映射与报告的 CPU 分属框架标签，不计入出错插件，避免污染插件自身的性能统计。
        failure.mappedStack = measure('framework.errorMapper.mapStack', () =>
          mapStack(stack)
        );
      } catch {
        /* 统计或映射失效时保留原始堆栈。 */
      }
      try {
        measure('framework.errorMapper.report', () => reportFailure(failure));
      } catch {
        /* 日志故障不影响返回原始故障。 */
      }
      return { ok: false, failure };
    }
  };
  // capture/mapStack 都是不依赖 this 的闭包，可直接解构传给 Kernel 或外部调用者。
  return {
    capture,
    mapStack,
    // typeof 保留通用计时函数的泛型签名，因此 setMeasure 只能接收同签名的包装器；
    // 替换观测适配器只影响之后的映射/报告统计，已解析的 map 与堆栈缓存保持有效。
    setMeasure: (wrapper: typeof measure) => {
      measure = wrapper;
    },
  };
};
