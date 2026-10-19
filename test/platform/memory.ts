/**
 * 文件摘要：Memory、RawMemory 与 segment 的严格平台模拟（platformFakes），供单元测试驱动 tick。
 *
 * 所属位置：test/platform/，测试基础设施，不进入游戏构建产物。
 * 语义依据公开的引擎与驱动源码（engine 4.3.2 的 game.js、driver 5.2.7 的 runtime.js 与 data.js）：
 * - 每 tick 开始时在全局对象上重新定义 `Memory` 访问器：首次读取时执行
 *   `JSON.parse(RawMemory.get() || "{}")`，结果的原型置为 null，并缓存为 RawMemory 的 _parsed；
 *   解析失败时 `Memory` 为 null。访问器可配置，因此可以被 delete 或重新定义。
 * - `RawMemory.set` 只接受长度不超过 2 MB（2 × 1024 × 1024 个字符）的字符串，并丢弃 _parsed。
 * - tick 结束时若 _parsed 存在，则以 `JSON.stringify(_parsed)` 覆盖原始文本；用户代码抛错不影响这一步。
 * - `setActiveSegments` 最多 10 个 0–99 的页号，替换上一次的请求；请求在下一 tick 生效，
 *   且一直保持到再次调用。激活的页出现在下一 tick 的 `RawMemory.segments` 中，从未写过的页为 ""。
 * - tick 结束时 `RawMemory.segments` 中的每个键都被保存（包括本 tick 读到的激活页）：最多 10 个键，
 *   页号 0–99，值为不超过 100 × 1024 个字符的字符串；违反时整个 tick 失败，本 tick 的写入全部丢弃。
 * 状态：持久化的 Memory 文本、segment 内容与激活请求保存在 createMemoryPlatform 返回的闭包中；
 * 副作用：tick 期间在目标全局对象（默认 globalThis）上定义 Memory 与 RawMemory。
 */

/** 引擎对 Memory 原始文本的长度上限（字符数）。 */
export const MEMORY_LIMIT = 2 * 1024 * 1024;
/** 单个 segment 的长度上限（字符数）。 */
export const SEGMENT_LIMIT = 100 * 1024;
/** 同时激活的 segment 数量上限，也是单 tick 可保存的 segment 数量上限。 */
export const SEGMENT_COUNT_LIMIT = 10;

/** 平台在 tick 结束时拒绝保存数据：对应驱动中使整个 tick 失败的检查。 */
export class PlatformError extends Error {
  override readonly name = 'PlatformError';
}

/** 一个 tick 的执行结果：error 为用户代码抛出的异常，未抛出时为 undefined。 */
export interface TickResult {
  readonly error: unknown;
}

export interface MemoryPlatformOptions {
  /** 初始的 Memory 原始文本；默认为空串，与新账户一致。 */
  readonly memory?: string;
  /** 初始的 segment 内容：{ [页号]: 页内容 }。 */
  readonly segments?: Readonly<Record<number, string>>;
  /** 安装 Memory 与 RawMemory 的全局对象；默认为 globalThis。 */
  readonly target?: object;
}

export interface MemoryPlatform {
  /** 已持久化的 Memory 原始文本。 */
  readonly memory: string;
  /** 当前生效的激活请求（下一 tick 加载这些页）。 */
  readonly activeSegments: readonly number[];
  /**
   * @description 读取已持久化的 segment 内容。
   * @param id 页号 0–99。
   * @returns 页内容；从未写过的页为 undefined。
   */
  segment(id: number): string | undefined;
  /**
   * @description 执行一个 tick：安装 Memory 访问器与 RawMemory，运行 run，再按平台规则持久化。
   * @param run 本 tick 的用户代码。
   * @returns 用户代码抛出的异常；未抛出时 error 为 undefined。
   * @throws {PlatformError} tick 结束时 segment 数量、页号、类型或长度违规，本 tick 的写入全部丢弃。
   */
  tick(run: () => void): TickResult;
}

/** 测试中访问 RawMemory 内部状态所用的形状；_parsed 是引擎缓存的已解析 Memory。 */
interface RawMemoryInternal extends RawMemory {
  _parsed?: unknown;
}

/**
 * @description 判断页号是否为 0–99 的整数。
 * @param id 待判断的页号。
 * @returns 合法页号时为 true。
 */
const isSegmentId = (id: number): boolean => Number.isInteger(id) && id >= 0 && id <= 99;

/**
 * @description 创建 Memory 与 segment 的严格平台模拟，持久状态保存在返回对象的闭包中。
 * @param options 初始 Memory 文本、初始 segment 与安装全局对象的目标，均可省略。
 * @returns 可逐 tick 驱动并查询持久状态的平台模拟。
 */
export const createMemoryPlatform = (options: MemoryPlatformOptions = {}): MemoryPlatform => {
  const target = (options.target ?? globalThis) as Record<string, unknown>;
  let memory = options.memory ?? '';
  // 已持久化的 segment：{ [页号]: 页内容 }。
  const segments = new Map<number, string>(Object.entries(options.segments ?? {}).map(([id, text]) => [Number(id), text]));
  let active: readonly number[] = [];

  /**
   * @description 执行一个 tick，语义见 MemoryPlatform.tick 与文件摘要中的平台规则。
   * @param run 本 tick 的用户代码。
   * @returns 用户代码抛出的异常；未抛出时 error 为 undefined。
   * @throws {PlatformError} tick 结束时 segment 保存违规。
   */
  const tick = (run: () => void): TickResult => {
    let data = memory;
    let requested: number[] | null = null;
    const loaded = Object.create(null) as Record<string, unknown>;
    for (const id of active) {
      loaded[id] = segments.get(id) ?? '';
    }

    const raw = Object.create(null) as RawMemoryInternal;
    Object.defineProperties(raw, {
      get: {
        /**
         * @description RawMemory.get：返回本 tick 当前的原始文本。
         * @returns 原始 Memory 文本。
         */
        value: (): string => data
      },
      set: {
        /**
         * @description RawMemory.set：替换原始文本，并丢弃已解析的 Memory 缓存。
         * @param value 新的原始文本。
         * @returns 无返回值。
         * @throws {Error} 不是字符串，或长度超过 2 MB。
         */
        value(value: unknown): void {
          if (typeof value !== 'string') {
            throw new Error('Raw memory value is not a string');
          }
          if (value.length > MEMORY_LIMIT) {
            throw new Error('Raw memory length exceeded 2 MB limit');
          }
          delete raw._parsed;
          data = value;
        },
      },
      segments: { value: loaded },
      setActiveSegments: {
        /**
         * @description RawMemory.setActiveSegments：替换激活请求，下一 tick 生效并持续到再次调用。
         * @param ids 页号数组，最多 10 个。
         * @returns 无返回值。
         * @throws {Error} 不是数组、超过 10 个或含非法页号。
         */
        value(ids: unknown): void {
          if (!Array.isArray(ids)) {
            throw new Error(`"${String(ids)}" is not an array`);
          }
          if (ids.length > SEGMENT_COUNT_LIMIT) {
            throw new Error('Only 10 memory segments can be active at the same time');
          }
          const next: number[] = [];
          for (const value of ids) {
            const id = parseInt(String(value), 10);
            if (!isSegmentId(id)) {
              throw new Error(`"${String(value)}" is not a valid segment ID`);
            }
            next.push(id);
          }
          requested = next;
        },
      },
    });

    target.RawMemory = raw;
    Object.defineProperty(target, 'Memory', {
      configurable: true,
      enumerable: true,
      /**
       * @description 引擎的惰性 Memory 访问器：首次读取时解析原始文本，结果无原型并缓存为 _parsed，随后把属性替换为值。
       * @returns 解析后的 Memory；解析失败时为 null。
       */
      get() {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.get() || '{}');
          Object.setPrototypeOf(parsed, null);
        } catch {
          parsed = null;
        }
        raw._parsed = parsed;
        Object.defineProperty(target, 'Memory', { configurable: true, enumerable: true, value: parsed });
        return parsed;
      },
    });

    let error: unknown;
    try {
      run();
    } catch (thrown) {
      error = thrown;
    }

    if (raw._parsed) {
      data = JSON.stringify(raw._parsed);
    }
    const keys = Object.keys(loaded);
    if (keys.length > SEGMENT_COUNT_LIMIT) {
      throw new PlatformError('Cannot save more than 10 memory segments on the same tick');
    }
    const saved = new Map<number, string>();
    for (const key of keys) {
      const id = parseInt(key, 10);
      const text = loaded[key];
      if (!isSegmentId(id)) {
        throw new PlatformError(`"${key}" is not a valid memory segment ID`);
      }
      if (typeof text !== 'string') {
        throw new PlatformError(`Memory segment #${key} is not a string`);
      }
      if (text.length > SEGMENT_LIMIT) {
        throw new PlatformError(`Memory segment #${key} has exceeded 100 KB length limit`);
      }
      saved.set(id, text);
    }

    memory = data;
    for (const [id, text] of saved) {
      segments.set(id, text);
    }
    if (requested) {
      active = requested;
    }
    return { error };
  };

  return {
    get memory() {
      return memory;
    },
    get activeSegments() {
      return active;
    },
    /**
     * @description 读取已持久化的 segment 内容。
     * @param id 页号。
     * @returns 页内容；从未写过的页为 undefined。
     */
    segment: (id) => segments.get(id),
    tick,
  };
};
