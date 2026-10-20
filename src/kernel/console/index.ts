/**
 * 文件摘要：kernel.console，控制台命令的注册、安装与调用隔离（设计见 docs/design/kernel/console.md，架构设计 5.8、11.9）。
 *
 * 所属位置：src/kernel/console/，kernel 内部模块；为 ModuleContext.console 与宿主侧的 Kernel.console(namespace) 提供注册器。
 * 平台事实：每个 tick 先执行 module.exports.loop()，再在同一全局作用域中求值控制台表达式（engine 4.3.2 src/game/game.js），
 * 所以命令总在 kernel 当 tick 的提交之后运行。命令以全局对象 `<命名空间>.<名称>` 的形式安装在注入的目标上。
 * 每次调用都在 try/catch 中，异常记录日志并以 `错误：<消息>` 返回，不传出到游戏控制台；结果为纯文本。
 * 状态：各命名空间的命令表与安装的全局对象保存在 createConsole 的闭包中，随 kernel 实例存在；
 * dispose 时替换为桩对象（宿主登记的离线处理函数在桩对象上继续可用），下一个实例重新注册时覆盖桩对象。
 */
import type { ConsoleRegistry } from '@/contracts/console';
import type { Logger } from '@/contracts/log';

/** 单次命令结果的长度上限（字符）。 */
export const CONSOLE_RESULT_LIMIT = 4000;
/** kernel 不可用时桩对象的命令结果。 */
export const OFFLINE_RESULT = 'kernel 未运行（重建或冷却中）';

/** 标记本模块安装的全局对象，用于区分游戏或其他代码的同名全局；模块级常量，不可变。 */
const MARK = Symbol('kernel.console');
/** 命令与设置名：小写字母开头的字母数字串；help 由本模块自动提供。 */
const NAME = /^[a-z][A-Za-z0-9]*$/;

/** 宿主侧注册器：在 ConsoleRegistry 之外可登记离线处理函数（console.md 第 4 节）。 */
export interface HostConsoleRegistry extends ConsoleRegistry {
  /**
   * @description 为已注册的命令登记离线处理函数：kernel 实例销毁后，桩对象调用它而不是返回桩结果。
   * 处理函数不得引用 kernel 实例，只能读取跨实例存在的状态（例如入口状态）。
   * @param name 已注册的命令名。
   * @param fn 离线处理函数。
   * @returns 无返回值；命令不存在时记录错误。
   */
  offline(name: string, fn: (...args: readonly unknown[]) => unknown): void;
}

/** kernel 内部接口。 */
export interface ConsoleHost {
  /**
   * @description 取得命名空间的注册器；同一命名空间多次调用共用同一命令表。
   * @param namespace 命名空间（模块 id 或宿主命名空间，如 ops）。
   * @returns 注册器。
   */
  registry(namespace: string): HostConsoleRegistry;
  /**
   * @description 把本实例安装的全部命名空间替换为桩对象，之后的注册一律忽略。可重复调用。
   * @returns 无返回值。
   */
  dispose(): void;
}

/** 创建选项，均由宿主注入。 */
export interface ConsoleOptions {
  /** 安装全局对象的目标：游戏中为 globalThis，测试中为隔离对象。 */
  readonly target: object;
  /**
   * @description 取得命名空间的日志，用于记录命令异常与注册错误。
   * @param namespace 命名空间。
   * @returns 该命名空间的 Logger。
   */
  logger(namespace: string): Logger;
}

/** 命令表中的一项。 */
interface Entry {
  readonly help: string;
  readonly fn?: (...args: readonly unknown[]) => unknown;
  readonly get?: () => unknown;
  readonly set?: (value: unknown) => void;
  offline?: (...args: readonly unknown[]) => unknown;
}

/** 一个命名空间：命令表与安装的全局对象；被拒绝安装时 object 为 undefined。 */
interface Namespace {
  /** { [命令或设置名]: 命令表项 }，按注册顺序列入 help。 */
  readonly entries: Map<string, Entry>;
  readonly object: Record<string | symbol, unknown> | undefined;
}

/**
 * @description 取异常的消息文本。
 * @param error 异常。
 * @returns 消息；不是 Error 时转为字符串。
 */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * @description 把命令返回值转为文本：字符串原样，undefined 为 ok，其他值经 JSON.stringify；超过上限时截断并注明。
 * @param value 命令返回值。
 * @returns 结果文本。
 */
export const formatResult = (value: unknown): string => {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === undefined) text = 'ok';
  else {
    try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  }
  return text.length > CONSOLE_RESULT_LIMIT
    ? `${text.slice(0, CONSOLE_RESULT_LIMIT)}…（已截断，共 ${text.length} 字符）`
    : text;
};

/**
 * @description 创建 kernel.console；构造不访问全局目标。
 * @param options 全局目标与日志。
 * @returns 宿主接口。
 */
export const createConsole = (options: ConsoleOptions): ConsoleHost => {
  const target = options.target as Record<string, unknown>;
  // { [命名空间]: 命令表与安装的对象 }，随实例存在。
  const spaces = new Map<string, Namespace>();
  let disposed = false;

  /**
   * @description 在错误边界中调用处理函数并格式化结果。
   * @param namespace 命名空间。
   * @param name 命令名。
   * @param fn 处理函数。
   * @param args 控制台传入的参数。
   * @returns 结果文本；抛错时为 `错误：<消息>`。
   */
  const invoke = (namespace: string, name: string, fn: (...args: readonly unknown[]) => unknown, args: readonly unknown[]): string => {
    try {
      return formatResult(fn(...args));
    } catch (error) {
      options.logger(namespace).error(`控制台命令 ${namespace}.${name} 失败`, error);
      return `错误：${messageOf(error)}`;
    }
  };

  /**
   * @description 生成命名空间的 help 文本。
   * @param namespace 命名空间。
   * @param entries 命令表。
   * @param offline 是否为桩对象的 help。
   * @returns 每行一个命令或设置及其说明。
   */
  const helpText = (namespace: string, entries: Map<string, Entry>, offline: boolean): string => {
    const lines = [...entries].map(([name, e]) => `${namespace}.${name}${e.fn ? '()' : ''}  ${e.help}`);
    if (offline) lines.unshift(`（${OFFLINE_RESULT}；只有离线命令可用）`);
    return lines.join('\n');
  };

  /**
   * @description 创建命名空间并安装全局对象；目标上已有不属于本模块的同名全局时拒绝安装。
   * @param namespace 命名空间。
   * @returns 命名空间记录。
   */
  const open = (namespace: string): Namespace => {
    let space = spaces.get(namespace);
    if (space) return space;
    const existing = target[namespace];
    const foreign = existing !== undefined && !(existing !== null && typeof existing === 'object' && MARK in existing);
    const entries = new Map<string, Entry>();
    let object: Record<string | symbol, unknown> | undefined;
    if (foreign) {
      options.logger(namespace).error(`全局 ${namespace} 已被占用，控制台命名空间未安装`);
    } else {
      object = Object.create(null) as Record<string | symbol, unknown>;
      Object.defineProperty(object, MARK, { value: true });
      Object.defineProperty(object, 'help', {
        enumerable: true,
        /**
         * @description 列出本命名空间的命令与设置。
         * @returns help 文本。
         */
        value: () => helpText(namespace, entries, false),
      });
      Object.defineProperty(target, namespace, { configurable: true, writable: true, value: object });
    }
    space = { entries, object };
    spaces.set(namespace, space);
    return space;
  };

  /**
   * @description 校验名称并登记命令表项。
   * @param namespace 命名空间。
   * @param name 名称。
   * @param entry 命令表项。
   * @returns 登记成功时为命名空间记录；否则为 undefined（已记录错误）。
   */
  const add = (namespace: string, name: string, entry: Entry): Namespace | undefined => {
    if (disposed) return undefined;
    const space = open(namespace);
    if (!NAME.test(name) || name === 'help' || space.entries.has(name)) {
      options.logger(namespace).error(`控制台命令名 ${namespace}.${name} 非法或重复，已忽略`);
      return undefined;
    }
    space.entries.set(name, entry);
    return space;
  };

  return {
    /**
     * @description 取得命名空间的注册器，语义见 ConsoleHost.registry。
     * @param namespace 命名空间。
     * @returns 注册器。
     */
    registry(namespace) {
      return {
        /**
         * @description 注册命令，语义见 ConsoleRegistry.command。
         * @param name 命令名。
         * @param help 说明。
         * @param fn 处理函数。
         * @returns 无返回值。
         */
        command(name, help, fn) {
          const space = add(namespace, name, { help, fn });
          if (space?.object) {
            Object.defineProperty(space.object, name, {
              enumerable: true,
              /**
               * @description 控制台入口：在错误边界中调用处理函数。
               * @param args 控制台参数。
               * @returns 结果文本。
               */
              value: (...args: unknown[]) => invoke(namespace, name, fn, args),
            });
          }
        },
        /**
         * @description 注册设置，语义见 ConsoleRegistry.setting。
         * @param name 设置名。
         * @param help 说明。
         * @param get 读取函数。
         * @param set 写入函数。
         * @returns 无返回值。
         */
        setting(name, help, get, set) {
          const space = add(namespace, name, { help, get, set });
          if (space?.object) {
            Object.defineProperty(space.object, name, {
              enumerable: true,
              /**
               * @description 读取设置；get 抛错时返回错误文本。
               * @returns 当前值或错误文本。
               */
              get: () => {
                try { return get(); } catch (error) {
                  options.logger(namespace).error(`控制台设置 ${namespace}.${name} 读取失败`, error);
                  return `错误：${messageOf(error)}`;
                }
              },
              /**
               * @description 写入设置；set 抛错时记录并忽略本次赋值。
               * @param value 新值。
               * @returns 无返回值。
               */
              set: (value: unknown) => {
                try { set(value); } catch (error) {
                  options.logger(namespace).error(`控制台设置 ${namespace}.${name} 写入被拒绝`, error);
                }
              },
            });
          }
        },
        /**
         * @description 登记离线处理函数，语义见 HostConsoleRegistry.offline。
         * @param name 已注册的命令名。
         * @param fn 离线处理函数。
         * @returns 无返回值。
         */
        offline(name, fn) {
          const entry = spaces.get(namespace)?.entries.get(name);
          if (!entry?.fn) { options.logger(namespace).error(`离线命令 ${namespace}.${name} 没有对应的命令`); return; }
          entry.offline = fn;
        },
      };
    },
    /**
     * @description 把已安装的命名空间替换为桩对象，语义见 ConsoleHost.dispose。
     * @returns 无返回值。
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [namespace, space] of spaces) {
        if (!space.object || target[namespace] !== space.object) continue;
        const stub = Object.create(null) as Record<string | symbol, unknown>;
        Object.defineProperty(stub, MARK, { value: true });
        Object.defineProperty(stub, 'help', {
          enumerable: true,
          /**
           * @description 列出命令，并注明 kernel 未运行。
           * @returns help 文本。
           */
          value: () => helpText(namespace, space.entries, true),
        });
        for (const [name, entry] of space.entries) {
          const offline = entry.offline;
          if (entry.fn) {
            Object.defineProperty(stub, name, {
              enumerable: true,
              /**
               * @description 桩命令：有离线处理函数时调用它，否则返回桩结果。
               * @param args 控制台参数。
               * @returns 结果文本。
               */
              value: (...args: unknown[]) => (offline ? invoke(namespace, name, offline, args) : OFFLINE_RESULT),
            });
          } else {
            Object.defineProperty(stub, name, {
              enumerable: true,
              /**
               * @description 桩设置：读取返回桩结果。
               * @returns 桩结果。
               */
              get: () => OFFLINE_RESULT,
              /**
               * @description 桩设置：忽略赋值。
               * @returns 无返回值。
               */
              set: () => undefined,
            });
          }
        }
        Object.defineProperty(target, namespace, { configurable: true, writable: true, value: stub });
      }
    },
  };
};
