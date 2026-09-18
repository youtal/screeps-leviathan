/**
 * 文件摘要
 *
 * 模块角色：core/logger 的日志实现，为 Runtime 和业务模块提供共享配置下的作用域日志器。
 *
 * 主要功能：控制日志等级、添加名称与颜色前缀，向控制台输出，并按策略发送 error 通知。
 *
 * 实现过程：创建工厂时合并默认配置和输出接口；scope 再应用局部配置，返回六种日志方法。
 * 启用的消息经 dyeText 生成前缀后送往输出接口，关闭的等级在格式化前返回。
 *
 * 技术要点：每个作用域按等级按需缓存前缀，随日志器跨 tick 复用，global reset 后重建。
 * 默认输出使用 console.log 和 Game.notify；输出异常被吞掉，邮件关闭策略不可由作用域重新开启。
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
     * 装配级邮件策略是硬上限：只有 mailPolicy === 'error' 时才可能发送邮件，
     * 作用域只能在该前提下关闭（notify: false）或跟随（undefined），
     * 不能在装配关闭时自行开启，避免模块绕过 App 对邮件行为的集中控制。
     * 邮件只对 error 等级有意义：其余等级即使 notify 为 true 也不会发送。
     */
    scope(scopeName: string, scopeOptions: ScopeLogOptions = {}): Logger {
      const levels = resolveLevels(scopeOptions.levels, assemblyLevels);
      const mailEnabled =
        levels.error && mailPolicy === 'error' && scopeOptions.notify !== false;

      /**
       * 前缀按等级惰性缓存：作用域名与配色在作用域生命周期内不变，首次用到某等级
       * 时生成一次着色前缀，之后每条日志只做一次字符串拼接，不再重复调用 dyeText。
       * 空作用域名约定为无前缀输出，直接返回空串、不进入缓存。
       */
      const prefixes: Partial<Record<Level, string>> = {};
      const prefixFor = (level: Level): string => {
        if (!scopeName) return '';
        let prefix = prefixes[level];
        if (prefix === undefined) {
          prefix = dyeText(`[${scopeName}] `, LEVEL_COLORS[level], true);
          prefixes[level] = prefix;
        }
        return prefix;
      };

      /**
       * 统一出口：关闭的等级在格式化之前返回，热路径不支付着色与拼接成本。
       */
      const emit = (level: Level, content: string, enabled: boolean): void => {
        if (!enabled) return;
        const line = prefixFor(level) + content;
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
