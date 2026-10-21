/**
 * 文件摘要：inspector 的纯函数：命令行参数、Memory 响应解码、Memory 状态判断、单元体积统计与输出格式化
 * （设计见 docs/proposal/2026-10-21-m1-scope.md 第 4 节，架构 13.1）。
 *
 * 所属位置：scripts/inspector/，开发工具，不进入游戏构建产物；由 Node 的类型剥离直接运行，所以只能以带扩展名的相对路径
 * 导入运行时代码。segment 的页头解码直接复用 src/kernel/segments/page.ts（该文件没有依赖），与游戏内的编码是同一份实现。
 * Memory 状态与项目标记的判断不能复用 src/kernel/memory/marker.ts（它以无扩展名的相对路径导入，Node 无法直接运行），
 * 这里按同一规则实现一份，由单元测试在相同输入上与 kernel 的 summarize 及 app.boot 的 memoryView 比对，防止规则走样。
 * 本文件只有纯函数，没有状态与 I/O；网络请求在 cli.ts，经 scripts/deploy/api.ts 的只读接口完成。
 */
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { decodePage } from '../../src/kernel/segments/page.ts';

/** 本项目的 Memory 身份，与 src/app/assembly 的 MEMORY_IDENTITY 一致（由单元测试比对）。 */
export const IDENTITY = { namespace: 'leviathan', signature: 'leviathan', schema: 1 } as const;
/** 引擎对 Memory 原始文本的长度上限（字符数）：架构第 2 节运行环境约束的"主 Memory 上限 2 MB"，与 kernel.memory 的 MEMORY_LIMIT 相同（由单元测试比对）。 */
export const MEMORY_LIMIT = 2 * 1024 * 1024;
/** 单个值或页正文输出的长度上限（字符数）；超出时截断并注明总长度。 */
export const OUTPUT_LIMIT = 20_000;
/** 引擎为新账户预置的根键：只有这些键且值都是空对象时 Memory 视为空（架构 11.3 的 EMPTY）。 */
const ENGINE_KEYS: ReadonlySet<string> = new Set(['creeps', 'spawns', 'rooms', 'flags', 'powerCreeps']);
/** 合法的运营模式，与 app.boot 的 BOOT_MODES（由 BootMode 的 satisfies 表生成）一致（由单元测试比对）。 */
export const MODES: ReadonlySet<string> = new Set(['NORMAL', 'RECOVERY', 'FRESH_START', 'TAKEOVER', 'SELF_ADOPT',
  'SHARD_SEED', 'STRANDED', 'DORMANT', 'AMBIGUOUS']);
/** 命名空间中按"两级键 → 单元"组织的空间：{ [空间名]: { [第一级键]: { [第二级键]: 单元 } } }。 */
const UNIT_SPACES = ['part', 'rooms', 'creeps', 'flags'] as const;
/** 已分配页号所属的 store（架构 6.8 的静态分配）：{ [页号]: store 名 }，与 kernel.segments 的 STORES 一致（由单元测试比对）。 */
export const PAGE_STORES: ReadonlyMap<number, 'stats' | 'backup'> = new Map([
  [50, 'stats'],
  ...[80, 81, 82, 83, 84, 85, 86, 87, 88, 89].map((id): [number, 'backup'] => [id, 'backup']),
]);
/** 各 store 的页用途说明：{ [store 名]: 说明 }。 */
const STORE_ROLES: Readonly<Record<'stats' | 'backup', string>> = { stats: '统计页（kernel.stats）', backup: 'Memory 备份区（bootPort）' };

const COMMANDS = ['marker', 'sizes', 'get', 'segment'] as const;
export type InspectCommand = (typeof COMMANDS)[number];

/** 解析后的命令行参数。 */
export interface InspectArgs {
  readonly command: InspectCommand;
  readonly account: string;
  readonly shard: string | undefined;
  /** get 的点分路径。 */
  readonly path: string | undefined;
  /** segment 的页号。 */
  readonly segment: number | undefined;
}

export const USAGE = [
  '用法：npm run inspect -- <命令> --account <账户> [--shard <shard>]',
  '  marker                项目标记与 Memory 状态',
  '  sizes                 Memory 重新序列化后的总长度与各单元的序列化长度',
  '  get <点分路径>         某个路径下的值，例如 leviathan.part.boot.control',
  '  segment <页号>         一页 segment 的页头与正文（0–99）',
  '只读：不写入 Memory 或 segment。每条命令都访问服务器，须显式给出 --account。',
].join('\n');

/**
 * @description 解析命令行参数并检查各命令的必需项。
 * @param argv 去掉 node 与脚本路径后的命令行参数。
 * @returns 命令、账户、shard 与命令参数。
 * @throws {Error} 命令未知、出现未知选项、缺少 --account、参数个数不符或页号不是 0–99 的十进制整数；
 * 命令未知或选项错误时消息含用法说明。
 * @example parseInspectArgs(['get', 'leviathan.sys', '--account', 'main'])
 */
export const parseInspectArgs = (argv: readonly string[]): InspectArgs => {
  let parsed: { values: { account?: string; shard?: string }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { account: { type: 'string' }, shard: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    // 例如 segment -1：parseArgs 把 -1 当作未知选项。
    throw new Error(`${(error as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (!COMMANDS.includes(command as InspectCommand)) throw new Error(USAGE);
  if (values.account === undefined) throw new Error(`${command} 必须用 --account 指定账户`);
  const expected = command === 'get' || command === 'segment' ? 1 : 0;
  if (rest.length !== expected) throw new Error(USAGE);
  let segment: number | undefined;
  if (command === 'segment') {
    // 只接受十进制数字：Number() 会把空串、'0x10'、'1e1' 与带空白的参数也转成合法页号。
    if (!/^\d{1,2}$/.test(rest[0])) throw new Error(`页号须为 0–99 的整数：${rest[0]}`);
    segment = Number(rest[0]);
  }
  return { command: command as InspectCommand, account: values.account, shard: values.shard,
    path: command === 'get' ? rest[0] : undefined, segment };
};

/** Memory 接口响应的解码结果。 */
export type MemoryRead =
  | { readonly status: 'value'; readonly value: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

/**
 * @description 解码 GET /api/user/memory 的 data 字段（scripts/deploy/api.ts 的 getMemory）。
 * @param data 响应的 data 字段原样。
 * @returns 值、路径不存在，或无法读取（服务器无法解析存储的文本、中间路径缺失，或格式未知）。
 */
export const decodeMemoryData = (data: unknown): MemoryRead => {
  if (data === undefined || data === null) return { status: 'missing' };
  if (data === 'Incorrect memory path') {
    return { status: 'unreadable', reason: '服务器无法解析存储的 Memory 文本，或中间路径不存在' };
  }
  if (typeof data !== 'string' || !data.startsWith('gz:')) return { status: 'unreadable', reason: '响应格式未知' };
  try {
    return { status: 'value', value: JSON.parse(gunzipSync(Buffer.from(data.slice(3), 'base64')).toString('utf8')) };
  } catch {
    return { status: 'unreadable', reason: 'gzip 或 JSON 解码失败' };
  }
};

/**
 * @description 判断值是否为非 null、非数组的对象。
 * @param value 待判断的值。
 * @returns 是对象时为 true。
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @description 判断值是否为非负安全整数。
 * @param value 待判断的值。
 * @returns 是时为 true。
 */
const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * @description 判断值是否为字符串数组。
 * @param value 待判断的值。
 * @returns 是时为 true。
 */
const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every((v) => typeof v === 'string');

/**
 * @description 按当前代码的结构校验项目标记，规则与 kernel.memory 的 checkMarker 相同。
 * @param value 待判断的项目标记。
 * @returns 签名与 schema 与本项目身份一致、各字段类型合法时为 true。
 */
const markerValid = (value: Record<string, unknown>): boolean => {
  if (value.sig !== IDENTITY.signature || value.schema !== IDENTITY.schema || typeof value.shard !== 'string'
    || typeof value.release !== 'string' || !isCount(value.epoch) || !isCount(value.lastRun)
    || !isObject(value.fp) || !isObject(value.mode)) return false;
  const { fp, mode } = value;
  return isStrings(fp.rooms) && isStrings(fp.spawnIds) && isCount(fp.creepCount) && MODES.has(mode.mode as string)
    && (mode.strength === 'strong' || mode.strength === 'medium') && isCount(mode.since) && isStrings(mode.evidence);
};

/** Memory 状态：架构 11.3 的 memState 加 app.boot 第 3.1 节的 UNLOADABLE。 */
export type MemoryState = 'EMPTY' | 'CORRUPT' | 'OURS' | 'OURS_NEWER' | 'FOREIGN' | 'UNLOADABLE';

/**
 * @description 由整个 Memory 判断状态，规则与 kernel.memory 的 summarize 加 app.boot 的 memoryView 相同。
 * OURS 只说明项目标记合法；其余单元能否完整加载以游戏内的判定为准（kernel 加载失败时 app.boot 判为 UNLOADABLE）。
 * @param read 整个 Memory 的读取结果。
 * @returns 状态与项目标记（签名相符时）。
 */
export const memoryState = (read: MemoryRead): { readonly state: MemoryState; readonly marker: Record<string, unknown> | null } => {
  if (read.status !== 'value' || !isObject(read.value)) return { state: read.status === 'missing' ? 'EMPTY' : 'CORRUPT', marker: null };
  const root = read.value;
  const keys = Object.keys(root);
  if (keys.every((key) => ENGINE_KEYS.has(key) && isObject(root[key]) && Object.keys(root[key] as object).length === 0)) {
    return { state: 'EMPTY', marker: null };
  }
  const data = Object.hasOwn(root, IDENTITY.namespace) ? root[IDENTITY.namespace] : undefined;
  const sys = isObject(data) && Object.hasOwn(data, 'sys') ? data.sys : undefined;
  if (!isObject(sys) || sys.sig !== IDENTITY.signature || !isCount(sys.schema)) return { state: 'FOREIGN', marker: null };
  if (sys.schema === IDENTITY.schema) return markerValid(sys) ? { state: 'OURS', marker: sys } : { state: 'FOREIGN', marker: null };
  return { state: (sys.schema as number) > IDENTITY.schema ? 'OURS_NEWER' : 'UNLOADABLE', marker: sys };
};

/**
 * @description 生成 marker 命令的输出。
 * @param read 整个 Memory 的读取结果。
 * @returns 多行文本：Memory 状态与项目标记各字段。
 */
export const formatMarker = (read: MemoryRead): string => {
  if (read.status === 'unreadable') return `Memory 无法读取：${read.reason}`;
  const { state, marker } = memoryState(read);
  const lines = [`Memory 状态：${state}（代码 schema ${IDENTITY.schema}）`];
  if (state === 'OURS') lines.push('（项目标记合法；其余单元能否完整加载以游戏内的判定为准）');
  if (marker === null) return [...lines, '没有本项目的项目标记'].join('\n');
  for (const key of ['sig', 'schema', 'shard', 'epoch', 'lastRun', 'release', 'fp', 'mode']) {
    lines.push(`${key}：${JSON.stringify(marker[key])}`);
  }
  return lines.join('\n');
};

/**
 * @description 统计 Memory 中各单元的序列化长度：本项目命名空间按系统单元、分区与实体单元逐个统计，其他根键各计一项。
 * @param root 整个 Memory。
 * @returns 按长度降序排列的 { 路径, 长度 }；路径为点分形式，例如 `leviathan.part.boot.control`。
 */
export const unitSizes = (root: Record<string, unknown>): { readonly path: string; readonly length: number }[] => {
  const sizes: { path: string; length: number }[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (key !== IDENTITY.namespace || !isObject(value)) {
      sizes.push({ path: key, length: JSON.stringify(value).length });
      continue;
    }
    for (const [space, content] of Object.entries(value)) {
      if (!(UNIT_SPACES as readonly string[]).includes(space) || !isObject(content)) {
        sizes.push({ path: `${key}.${space}`, length: JSON.stringify(content).length });
        continue;
      }
      for (const [first, units] of Object.entries(content)) {
        if (!isObject(units)) {
          sizes.push({ path: `${key}.${space}.${first}`, length: JSON.stringify(units).length });
          continue;
        }
        for (const [second, unit] of Object.entries(units)) {
          sizes.push({ path: `${key}.${space}.${first}.${second}`, length: JSON.stringify(unit).length });
        }
      }
    }
  }
  return sizes.sort((a, b) => b.length - a.length || (a.path < b.path ? -1 : 1));
};

/**
 * @description 生成 sizes 命令的输出。
 * @param read 整个 Memory 的读取结果。
 * @returns 多行文本：重新序列化后的总长度与上限的比例，以及各单元的长度。
 */
export const formatSizes = (read: MemoryRead): string => {
  if (read.status === 'unreadable') return `Memory 无法读取：${read.reason}`;
  if (read.status === 'missing') return 'Memory 为空';
  if (!isObject(read.value)) return 'Memory 的根不是对象，无法统计（Memory 状态 CORRUPT）';
  // 服务器先解析原文再重新序列化，原文的空白与转义写法不保留（审计 DV-07）。本项目 kernel 写入的就是紧凑的
  // JSON.stringify 结果，两者相同；外来或手工编辑过的 Memory 原文可能更长。
  const total = JSON.stringify(read.value).length;
  const lines = [`Memory 重新序列化后的长度 ${total} 个字符，占上限 ${(total / MEMORY_LIMIT * 100).toFixed(1)}%`,
    '（服务器返回的是解析后的数据：本项目写入的 Memory 与原文长度相同，外来或手工编辑过的 Memory 原文可能更长）'];
  for (const { path, length } of unitSizes(read.value)) lines.push(`${String(length).padStart(9)}  ${path}`);
  return lines.join('\n');
};

/**
 * @description 截断过长的输出文本。
 * @param text 文本。
 * @returns 不超过 OUTPUT_LIMIT 时原样返回；否则截断并注明总长度。
 */
const truncate = (text: string): string =>
  text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n…（已截断，共 ${text.length} 个字符）`;

/**
 * @description 生成 get 命令的输出。
 * @param path 点分路径。
 * @param read 该路径的读取结果。
 * @returns 格式化的值，或路径不存在、无法读取的说明。
 */
export const formatValue = (path: string, read: MemoryRead): string => {
  if (read.status === 'missing') return `${path} 不存在`;
  if (read.status === 'unreadable') return `${path} 无法读取：${read.reason}`;
  return truncate(JSON.stringify(read.value, null, 2));
};

/**
 * @description 生成 segment 命令的输出：页的用途、页头，以及按所属 store 的格式说明正文。
 * 统计页的正文是一个 JSON 对象（kernel.stats），格式化输出；备份页的正文是备份时原始 Memory 文本的一段，
 * 完整备份须取 generation 相同的 n 页按批次内序号拼接（kernel.bootPort 的备份状态机）；其他页原样输出。
 * @param id 页号。
 * @param data GET /api/user/memory-segment 的 data 字段原样。
 * @returns 多行文本。
 */
export const formatSegment = (id: number, data: unknown): string => {
  const store = PAGE_STORES.get(id);
  const role = store ? STORE_ROLES[store] : '未分配用途';
  const text = typeof data === 'string' ? data : '';
  if (text === '') return `第 ${id} 页（${role}）为空：从未写入，或已被清空`;
  const page = decodePage(text);
  if (!page) return `第 ${id} 页（${role}）不是本项目的页格式，共 ${text.length} 个字符：\n${truncate(text)}`;
  const { v, o, g, e, i, n } = page.header;
  const head = `第 ${id} 页（${role}）：owner ${o}，数据版本 ${v}，generation ${g}，epoch ${e}，批次内第 ${i + 1}/${n} 页，正文 ${page.body.length} 个字符`;
  if (store === 'stats') {
    try {
      return [head, '正文为统计 JSON：', truncate(JSON.stringify(JSON.parse(page.body), null, 2))].join('\n');
    } catch {
      return [head, '正文不是合法的 JSON：', truncate(page.body)].join('\n');
    }
  }
  if (store === 'backup') {
    return [head, `正文为备份时原始 Memory 文本的第 ${i + 1} 段（共 ${n} 段）；完整备份须取 generation ${g} 的 ${n} 页按段序拼接：`,
      truncate(page.body)].join('\n');
  }
  return [head, truncate(page.body)].join('\n');
};
