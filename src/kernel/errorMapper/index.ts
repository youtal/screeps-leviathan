/**
 * 文件摘要：kernel.errorMapper，把任意抛出值规范化为文本，并在 CPU 允许时把 main 模块的堆栈位置映射回源码
 * （设计见 docs/design/kernel/errorMapper.md）。
 *
 * 所属位置：src/kernel/errorMapper/，kernel 内部模块，零依赖：source map 的加载、bucket 与剩余 CPU 都由装配方注入；
 * 不写日志（由 logger 调用它，反向依赖会形成循环与递归）。只服务日志，不影响控制流：任何内部异常都退回原始文本。
 * 状态（均在 createErrorMapper 的闭包中，随实例存在于一个 global）：
 * - lines：首次需要映射时解码一次的 mappings；loadFailed 为 true 后本 global 不再尝试加载或解码；
 * - cache：{ [原始堆栈文本]: 映射后的完整文本 }，最多 MAP_CACHE_SIZE 条，满后按插入顺序丢弃最早的一条。
 * 成本：解码与 mappings 长度成正比，只在首次映射时发生；bucket 不足或本 tick 剩余 CPU 不足时不解码、不映射。
 */
import { decodeMappings, lookup } from './vlq';

/** bucket 低于此值时不做映射。 */
export const ERROR_MAP_BUCKET = 1000;
/** 每条堆栈最多映射的帧数。 */
const MAP_FRAME_LIMIT = 10;
/** 映射结果缓存的最大条数。 */
const MAP_CACHE_SIZE = 50;
/** 匹配位于 main 模块的堆栈帧：可选的函数名部分与 `main:<行>:<列>`。 */
const FRAME = /^(\s*at\s+)(?:(.*?)\s+\()?main:(\d+):(\d+)\)?\s*$/;

/** 错误规范化与源码映射。 */
export interface ErrorMapper {
  /**
   * @description 把任意抛出值规范化为可读文本，CPU 允许时映射 main 模块的堆栈位置。
   * @param error 任意抛出值。
   * @returns 规范化后的文本；从不抛错。
   */
  format(error: unknown): string;
}

/** 创建 errorMapper 的选项。 */
export interface ErrorMapperOptions {
  /** 加载 source map 对象，游戏中为 () => require('main.js.map')；不可用时抛错或返回非对象。 */
  readonly loadMap: () => unknown;
  /** 当前 bucket。 */
  readonly bucket: () => number;
  /** 本 tick 剩余 CPU 减去收尾预留后的余量；不大于 0 时不映射。 */
  readonly remaining: () => number;
}

/** 解码后可用于映射的 source map。 */
interface LoadedMap {
  readonly lines: Int32Array[];
  readonly sources: readonly string[];
}

/**
 * @description 把 source map 中的源文件路径规范为相对仓库根目录的形式，例如 `../src/main.ts` → `src/main.ts`。
 * @param source source map 中的源文件路径。
 * @returns 去掉开头 `./` 与 `../` 后的路径。
 */
const normalizeSource = (source: string): string => source.replace(/^(\.\.?\/)+/, '');

/**
 * @description 安全读取对象属性；属性访问器抛错时返回 undefined。
 * @param target 目标对象。
 * @param key 属性名。
 * @returns 属性值；读取失败时为 undefined。
 */
const safeGet = (target: object, key: string): unknown => {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

/**
 * @description 创建 errorMapper 实例；构造时不加载、不解码。
 * @param options source map 加载函数、bucket 与剩余 CPU 读数。
 * @returns errorMapper 实例。
 */
export const createErrorMapper = (options: ErrorMapperOptions): ErrorMapper => {
  let loaded: LoadedMap | undefined;
  let loadFailed = false;
  // { [原始堆栈文本]: 映射后的完整文本 }；Map 保持插入顺序，满后删除第一个键。
  const cache = new Map<string, string>();

  /**
   * @description 首次需要时加载并解码 source map；失败后本 global 不再尝试。
   * @returns 解码后的映射；不可用时为 undefined。
   */
  const ensureMap = (): LoadedMap | undefined => {
    if (loaded || loadFailed) return loaded;
    try {
      const map = options.loadMap() as { mappings?: unknown; sources?: unknown } | null;
      if (!map || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) throw new Error('source map 不可用');
      loaded = { lines: decodeMappings(map.mappings), sources: map.sources.map(String) };
    } catch {
      loadFailed = true;
    }
    return loaded;
  };

  /**
   * @description 映射一段堆栈文本中位于 main 模块的帧，最多 MAP_FRAME_LIMIT 帧；无法映射的帧原样保留。
   * @param stack 原始堆栈文本。
   * @param map 解码后的映射。
   * @returns 映射后的堆栈文本。
   */
  const mapStack = (stack: string, map: LoadedMap): string => {
    let mapped = 0;
    return stack.split('\n').map((frame) => {
      if (mapped >= MAP_FRAME_LIMIT) return frame;
      const match = FRAME.exec(frame);
      if (!match) return frame;
      mapped += 1;
      const position = lookup(map.lines, Number(match[3]) - 1, Number(match[4]) - 1);
      const source = position ? map.sources[position.source] : undefined;
      if (!position || source === undefined) return frame;
      const where = `${normalizeSource(source)}:${position.line + 1}:${position.column + 1}`;
      return match[2] ? `${match[1]}${match[2]} (${where})` : `${match[1]}${where}`;
    }).join('\n');
  };

  /**
   * @description 在允许的条件下映射堆栈：命中缓存直接返回；CPU 不足时注明未映射；映射不可用时返回原文。
   * @param stack 原始堆栈文本。
   * @returns 映射后或原始的堆栈文本。
   */
  const withMapping = (stack: string): string => {
    const cached = cache.get(stack);
    if (cached !== undefined) return cached;
    if (!stack.split('\n').some((frame) => FRAME.test(frame))) return stack;
    if (options.bucket() < ERROR_MAP_BUCKET || options.remaining() <= 0) return `${stack}\n（未映射：CPU 保护）`;
    const map = ensureMap();
    if (!map) return stack;
    const result = mapStack(stack, map);
    if (cache.size >= MAP_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    cache.set(stack, result);
    return result;
  };

  return {
    /**
     * @description 规范化抛出值并在条件允许时映射堆栈，语义见 ErrorMapper.format。
     * @param error 任意抛出值。
     * @returns 规范化后的文本；从不抛错。
     */
    format(error) {
      try {
        if (error instanceof Error) {
          const stack = safeGet(error, 'stack');
          const header = `${String(safeGet(error, 'name') ?? 'Error')}: ${String(safeGet(error, 'message') ?? '')}`;
          return typeof stack === 'string' && stack.length > 0 ? withMapping(stack) : header;
        }
        return `非 Error 抛出值：${typeof error === 'string' ? error : String(error)}`;
      } catch {
        return '（无法格式化的错误）';
      }
    },
  };
};
