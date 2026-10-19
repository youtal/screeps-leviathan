/**
 * 文件摘要：kernel.logger，按作用域输出日志（设计见 docs/design/kernel/README.md 第 5 节，契约见 src/contracts/log.ts）。
 *
 * 所属位置：src/kernel/logger/，kernel 内部模块，零依赖：输出端、当前 tick、错误格式化函数与各级别默认开关
 * 都由装配方注入，游戏中分别为 console.logUnsafe（不存在时为 console.log）、Game.time、errorMapper.format 与装配配置，测试中可替换。
 * 级别：debug、info、success（游戏内关键状态转移成功）、warn、error。
 * 双层开关：第一层是根对象的默认值（初始化时必须为每个级别给出，可由 setDefault 修改）；第二层是作用域的覆盖值
 * （业务模块经 Logger.configLevel 设置）。实际开关取本作用域覆盖值，其次是父作用域（实例作用域继承所属模块）的覆盖值，
 * 都没有时取默认值。覆盖只存于 heap，global reset 后由模块在 setup 中重新设置。
 * 输出格式：`[<tick>] <级别> <作用域>: <正文>`；error 另起一行附上格式化后的错误文本。
 * 上色（color 选项，只在输出端渲染 HTML 时由装配方开启）：前缀 `[<tick>] <级别>` 包在按级别着色的 span 中；
 * 同时转义作用域与正文中的 &、<、>，否则堆栈里的 `<anonymous>` 等文本会被当成标签吞掉；正文中的换行改为 `<br>`，
 * 否则 HTML 会把换行折叠成空格，多行堆栈挤成一行。
 * 状态：根对象的共享状态（注入的选项与默认开关）只有一份；每个作用域是一个 ScopedLogger 扁平对象，
 * 只保存作用域名、父作用域与覆盖表，方法在原型上共享（架构 12.1）。作用域 Logger 不缓存，由调用方（kernel.context）按需缓存。
 * 写日志永远不向调用方抛错：输出端、格式化函数或正文函数抛错时，分别丢弃该行、退回 String(error)、输出说明。
 * 成本：控制台输出计入 CPU；级别关闭时直接返回，函数形式的正文不求值。
 */
import type {
  LogLevel,
  LogLevelSwitches,
  LogMessage,
  Logger,
} from "@/contracts/log";

/** 日志输出端：接收一行完整文本。 */
export type LogSink = (line: string) => void;

/** 全部级别，按严重程度从低到高。 */
export const LOG_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "success",
  "warn",
  "error",
];

/** { [级别]: 前缀颜色 }：debug 天青、info 灰、success 绿、warn 橙、error 红。 */
export const LEVEL_COLORS: Readonly<Record<LogLevel, string>> = {
  debug: "#00f7f6",
  info: "#95a5a6",
  success: "#2ecc71",
  warn: "#f39c12",
  error: "#e74c3c",
};

/** 创建日志根对象的选项。 */
export interface LoggerOptions {
  /** 输出端，游戏中为 console.logUnsafe，不存在时为 console.log。 */
  readonly sink: LogSink;
  /** 当前 tick，游戏中为 () => Game.time。 */
  readonly time: () => number;
  /** 把任意抛出值规范化为文本，游戏中为 errorMapper.format。 */
  readonly format: (error: unknown) => string;
  /** 各级别的默认开关（第一层），必须为每个级别给出。 */
  readonly levels: LogLevelSwitches;
  /** 是否按级别给前缀上色（输出 HTML），默认 false；输出端能渲染 HTML 时由装配方按使用者设置开启。 */
  readonly color?: boolean;
}

/** 日志根对象：派生作用域 Logger，并持有各级别的默认开关。 */
export interface LogRoot {
  /**
   * @description 派生一个作用域 Logger；不缓存，调用方按需缓存。
   * @param scope 作用域，通常为模块 ID 或进程键。
   * @param parent 父作用域（同一根对象派生的 Logger），未覆盖的级别继承它的覆盖值；实例作用域以所属模块为父。
   * @returns 作用域已绑定的 Logger。
   * @throws {Error} parent 不是本根对象派生的 Logger。
   */
  scope(scope: string, parent?: Logger): Logger;
  /**
   * @description 修改某个级别的默认开关（第一层），对已派生且未覆盖该级别的 Logger 立即生效。
   * @param level 日志级别。
   * @param enabled 是否输出。
   * @returns 无返回值。
   */
  setDefault(level: LogLevel, enabled: boolean): void;
  /**
   * @description 读取当前的默认开关。
   * @returns 各级别默认开关的副本。
   */
  defaults(): LogLevelSwitches;
}

/** 日志根对象的共享状态：注入的选项与可修改的默认开关；所有作用域 Logger 引用同一份。 */
interface RootState {
  readonly options: LoggerOptions;
  readonly defaults: Record<LogLevel, boolean>;
}

/**
 * @description 转义 HTML 特殊字符，使文本在游戏控制台中原样显示。
 * @param text 原始文本。
 * @returns 转义了 &、<、> 的文本。
 */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @description 格式化错误；格式化函数自身抛错时退回 String(error)，仍然失败时给出固定文本。
 * @param root 日志根对象的共享状态。
 * @param error 任意抛出值。
 * @returns 错误文本。
 */
const describe = (root: RootState, error: unknown): string => {
  try {
    return root.options.format(error);
  } catch {
    try {
      return String(error);
    } catch {
      return "（无法格式化的错误）";
    }
  }
};

/**
 * 作用域 Logger。实例级 Logger 随进程数增长，按架构 12.1 用无继承的扁平 class：方法在原型上共享，
 * 每个对象只有固定顺序初始化的四个字段，不携带闭包。
 */
class ScopedLogger implements Logger {
  /** 日志根对象的共享状态。 */
  readonly root: RootState;
  /** 作用域名，即模块 ID 或进程键。 */
  readonly name: string;
  /** 父作用域；实例作用域以所属模块为父，未覆盖的级别继承它。 */
  readonly parent: ScopedLogger | undefined;
  /** { [级别]: 覆盖值 }，只记录被覆盖的级别；存于 heap。 */
  readonly overrides: Partial<Record<LogLevel, boolean>>;

  /**
   * @description 创建作用域 Logger。
   * @param root 日志根对象的共享状态。
   * @param name 作用域名。
   * @param parent 父作用域。
   */
  constructor(root: RootState, name: string, parent: ScopedLogger | undefined) {
    this.root = root;
    this.name = name;
    this.parent = parent;
    this.overrides = {};
  }

  /**
   * @description 输出调试日志。
   * @param message 正文或返回正文的函数。
   * @returns 无返回值。
   */
  debug(message: LogMessage): void {
    this.emit("debug", message);
  }

  /**
   * @description 输出一般信息日志。
   * @param message 正文或返回正文的函数。
   * @returns 无返回值。
   */
  info(message: LogMessage): void {
    this.emit("info", message);
  }

  /**
   * @description 汇报游戏内关键状态转移成功。
   * @param message 正文或返回正文的函数。
   * @returns 无返回值。
   */
  success(message: LogMessage): void {
    this.emit("success", message);
  }

  /**
   * @description 输出警告日志。
   * @param message 正文或返回正文的函数。
   * @returns 无返回值。
   */
  warn(message: LogMessage): void {
    this.emit("warn", message);
  }

  /**
   * @description 输出错误日志；给出 error 时另起一行附上格式化后的错误文本。
   * @param message 正文或返回正文的函数。
   * @param error 可选的抛出值。
   * @returns 无返回值。
   */
  error(message: LogMessage, error?: unknown): void {
    this.emit("error", message, error);
  }

  /**
   * @description 一次覆盖一个或多个级别，undefined 取消对应级别的覆盖；未列出的级别保持原状。先整体校验，校验失败时不修改任何级别。
   * @param levels { [级别]: 开关或 undefined }。
   * @returns 无返回值。
   * @throws {TypeError} 出现未知级别或非布尔值。
   */
  configLevel(
    levels: Readonly<Partial<Record<LogLevel, boolean | undefined>>>,
  ): void {
    const entries = Object.entries(levels) as [LogLevel, boolean | undefined][];
    for (const [level, enabled] of entries) {
      if (
        !LOG_LEVELS.includes(level) ||
        (enabled !== undefined && typeof enabled !== "boolean")
      ) {
        throw new TypeError(`日志级别配置非法：${level}`);
      }
    }
    for (const [level, enabled] of entries) {
      if (enabled === undefined) delete this.overrides[level];
      else this.overrides[level] = enabled;
    }
  }

  /**
   * @description 计算某个级别的实际开关：本作用域覆盖值，其次父作用域，最后默认值。
   * @param level 日志级别。
   * @returns 会输出时为 true。
   */
  enabled(level: LogLevel): boolean {
    for (
      let scope: ScopedLogger | undefined = this;
      scope;
      scope = scope.parent
    ) {
      const value = scope.overrides[level];
      if (value !== undefined) return value;
    }
    return this.root.defaults[level];
  }

  /**
   * @description 级别开启时求值正文、拼出一行并交给输出端；上色时着色前缀、转义作用域与正文，并把正文换行改为 `<br>`。
   * 正文函数抛错时输出说明；输出端抛错时丢弃该行。
   * @param level 日志级别。
   * @param message 正文或返回正文的函数。
   * @param error 仅 error 级别使用的抛出值。
   * @returns 无返回值。
   */
  private emit(level: LogLevel, message: LogMessage, error?: unknown): void {
    if (!this.enabled(level)) return;
    const { options } = this.root;
    let text: string;
    try {
      text = typeof message === "function" ? message() : message;
    } catch (thrown) {
      text = `（日志正文求值失败）${describe(this.root, thrown)}`;
    }
    if (error !== undefined) text = `${text}\n${describe(this.root, error)}`;
    try {
      const prefix = `[${options.time()}] ${level.toUpperCase()}`;
      options.sink(
        options.color
          ? `<span style="color:${LEVEL_COLORS[level]}">${prefix}</span> ${escapeHtml(this.name)}: ${escapeHtml(text).replace(/\n/g, '<br>')}`
          : `${prefix} ${this.name}: ${text}`,
      );
    } catch {
      // 日志失败不能影响调用方；此处也无法再写日志。
    }
  }
}

/**
 * @description 创建日志根对象。
 * @param options 输出端、当前 tick、错误格式化函数、各级别默认开关与是否上色。
 * @returns 日志根对象。
 * @throws {TypeError} levels 没有为每个级别给出布尔值。
 */
export const createLogRoot = (options: LoggerOptions): LogRoot => {
  for (const level of LOG_LEVELS) {
    if (typeof options.levels?.[level] !== "boolean")
      throw new TypeError(`日志级别 ${level} 缺少默认开关`);
  }
  const root: RootState = { options, defaults: { ...options.levels } };
  return {
    /**
     * @description 派生作用域 Logger，语义见 LogRoot.scope。
     * @param scope 作用域。
     * @param parent 父作用域。
     * @returns 作用域已绑定的 Logger。
     * @throws {Error} parent 不是本根对象派生的 Logger。
     */
    scope(scope, parent) {
      if (
        parent !== undefined &&
        !(parent instanceof ScopedLogger && parent.root === root)
      ) {
        throw new Error("父作用域不属于本日志根对象");
      }
      return new ScopedLogger(root, scope, parent);
    },
    /**
     * @description 修改某个级别的默认开关，语义见 LogRoot.setDefault。
     * @param level 日志级别。
     * @param enabled 是否输出。
     * @returns 无返回值。
     */
    setDefault(level, enabled) {
      root.defaults[level] = enabled;
    },
    /**
     * @description 读取当前默认开关的副本。
     * @returns 各级别默认开关。
     */
    defaults() {
      return { ...root.defaults };
    },
  };
};
