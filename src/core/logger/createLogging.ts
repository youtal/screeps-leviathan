/**
 * 文件摘要：实现内核日志能力——等级过滤、作用域前缀、着色格式化和双通道输出。
 *
 * 模块位置：core/logger 的运行时实现（模块入口见 ./index.ts，公共协议见
 * `src/contracts/logging.ts`）。createLogging 在 Runtime 装配阶段调用一次，
 * 返回的 LoggerFactory 被注入模块环境（env.log）与内核消费者（EventBus、
 * Profiler、ErrorMapper），使全项目共享同一套等级、端口与邮件策略。
 *
 * 输入是装配级 LoggingOptions（等级、邮件策略、分组间隔、端口覆盖）与每次
 * scope() 传的作用域名/局部覆盖；输出是遵循 Logger 契约的作用域日志器。
 * 作用域名会成为 `[name] ` 前缀，并按等级着色，文本渲染复用 utils/console 的
 * dyeText，HTML 表单与帮助面板不因为共用着色函数而进入内核职责。
 *
 * 状态与副作用：闭包只保存解析后的等级、策略与端口引用，不读写 Memory、
 * 不依赖 Profiler/ErrorMapper，也不访问 Game——只有启用邮件且真的触发 error
 * 时，默认端口才会调用 Game.notify。global reset 后由装配方重新创建。
 * 性能取舍：等级关闭时在格式化前直接返回，热路径只付一次布尔判断；输出端口
 * 抛错被吞掉并只丢失当条日志，观测失败绝不中断业务，也不递归记录。
 */
import type {
  Logger,
  LoggerFactory,
  LoggingOptions,
  LogOptions,
  LogOutput,
  ScopeLogOptions,
} from '@/contracts/logging';
import { DEFAULT_LOG_CONFIG } from '@/setting';
import { Color, dyeText } from '@/utils/console';

/** 六个等级的方法名；同时作为等级键、颜色表键和作用域覆盖的键。 */
type Level = keyof Logger;

/**
 * 等级到前缀颜色的固定映射：语义色（蓝=调试、橙=警告、红=错误、绿=成功、
 * 青=信息、紫=报告）与 Logger 方法一一对应，集中定义避免各处自行取色。
 */
const LEVEL_COLORS: Record<Level, Color> = {
  debug: Color.Blue,
  warn: Color.Orange,
  error: Color.Red,
  success: Color.Green,
  info: Color.Cyan,
  report: Color.Violet,
};

/**
 * 项目默认等级开关。
 *
 * 键名与 LogOptions 并不完全同名：默认配置沿用历史命名 `warning`，而对外
 * 契约使用 `warn`，转换只发生在这一个函数里。默认值本身来自 setting，
 * 使"哪些等级默认打开"是项目级决策而不是内核硬编码。
 */
const defaultLevels = (): Record<Level, boolean> => ({
  debug: DEFAULT_LOG_CONFIG.debug,
  warn: DEFAULT_LOG_CONFIG.warning,
  error: DEFAULT_LOG_CONFIG.error,
  success: DEFAULT_LOG_CONFIG.success,
  info: DEFAULT_LOG_CONFIG.info,
  report: DEFAULT_LOG_CONFIG.report,
});

/**
 * 逐等级解析开关：override 中的字段优先，undefined 回退 base。
 * 用 `??` 而不是 `||`，因此显式 false 能被保留，用于单独关闭某个等级。
 */
const resolveLevels = (
  override: LogOptions | undefined,
  base: Record<Level, boolean>
): Record<Level, boolean> => ({
  debug: override?.debug ?? base.debug,
  warn: override?.warn ?? base.warn,
  error: override?.error ?? base.error,
  success: override?.success ?? base.success,
  info: override?.info ?? base.info,
  report: override?.report ?? base.report,
});

/**
 * 创建日志工厂。
 *
 * 装配阶段解析一次配置，之后 scope() 只做等级合并与闭包创建，运行期不再读配置；
 * 因此同一工厂派生出的所有日志器共享端口与邮件策略，只有作用域名与等级覆盖不同。
 * notifyInterval 是默认邮件端口调用 Game.notify 的分组间隔（分钟），必须为正整数；
 * 非法值在装配阶段立即抛错，避免运行期产生难以定位的通知行为。
 */
export const createLogging = (options: LoggingOptions = {}): LoggerFactory => {
  const assemblyLevels = resolveLevels(options.levels, defaultLevels());
  const mailPolicy = options.notify ?? 'off';
  const notifyInterval = options.notifyInterval ?? 60;
  if (!Number.isInteger(notifyInterval) || notifyInterval < 1)
    throw new Error('Invalid notify interval');

  /**
   * 输出端口。默认实现写 console.log / Game.notify，调用方可以整条通道替换
   * （测试收集文本、生产静默或转存）。这里用 `??` 逐通道回退而不是展开覆盖，
   * 避免调用方显式传 undefined 时把端口打穿成 undefined。
   */
  const defaultOutput: LogOutput = {
    write: (line) => {
      console.log(line);
    },
    notify: (line) => {
      Game.notify(line, notifyInterval);
    },
  };
  const output: LogOutput = {
    write: options.output?.write ?? defaultOutput.write,
    notify: options.output?.notify ?? defaultOutput.notify,
  };

  /**
   * 输出端口不可信：注入实现抛错（包括 console 不存在、Game 未就绪）时只丢弃
   * 当条日志。此处不记录失败，避免日志失败再触发日志形成递归回路。
   */
  const safe = (channel: (line: string) => void, line: string): void => {
    try {
      channel(line);
    } catch {
      /* 观测失败静默降级：保留业务执行，不保留本条输出。 */
    }
  };

  return {
    /**
     * 派生作用域日志器。作用域名只影响前缀；levels 逐字段覆盖装配等级；
     * notify 覆盖装配策略，undefined 时由 `mailPolicy === 'error'` 决定。
     * 邮件只对 error 等级有意义：其余等级即使开启 notify 也不会发送邮件。
     */
    scope(scopeName: string, scopeOptions: ScopeLogOptions = {}): Logger {
      const levels = resolveLevels(scopeOptions.levels, assemblyLevels);
      const mailEnabled =
        levels.error && (scopeOptions.notify ?? mailPolicy === 'error');

      /**
       * 统一出口：关闭的等级在格式化之前返回，热路径不支付着色成本；
       * 前缀按等级取色并复用一个函数生成，空作用域名时退化为无前缀输出。
       */
      const emit = (level: Level, content: string, enabled: boolean): void => {
        if (!enabled) return;
        const prefix = scopeName
          ? dyeText(`[${scopeName}] `, LEVEL_COLORS[level], true)
          : '';
        const line = prefix + content;
        safe(output.write, line);
        if (level === 'error' && mailEnabled) safe(output.notify, line);
      };

      return {
        debug: (content) => emit('debug', content, levels.debug),
        warn: (content) => emit('warn', content, levels.warn),
        error: (content) => emit('error', content, levels.error),
        success: (content) => emit('success', content, levels.success),
        info: (content) => emit('info', content, levels.info),
        report: (content) => emit('report', content, levels.report),
      };
    },
  };
};
