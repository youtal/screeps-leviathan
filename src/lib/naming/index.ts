/**
 * 文件摘要：lib.naming，正常流程创建的 creep 与 spawn 的名称格式化与校验（设计见 docs/design/lib/naming.md，架构设计 9.2、11.3、11.5、11.6）。
 *
 * 所属位置：src/lib/naming/，lib 层的无状态纯函数。名称格式：
 *   <前缀>-<来源 shard>-<出生用途>-<目标 shard>-<出生 tick 的 base36>.<同 tick 序号的 base36>-<校验位>
 * 校验位为 hashString(校验位之前的全部文本 + salt) mod 36 的 base36 字符；前缀与 salt 来自运营配置，由调用方传入。
 * 输入输出：formatName 由字段生成名称（spawnQueue 分配序号后调用）；verifyName 实现架构 11.3 的 sig(name)，
 * 通过时返回解析出的字段，供跨 shard 判定（11.5）与认领（11.6）使用。
 * 规范形式：每个字段只接受一种写法（base36 小写、无前导零），所以 formatName(verifyName(n)) === n，
 * 同一组字段只对应一个名称。唯一性来自来源 shard、出生 tick 与序号的组合，校验位只用于识别本系统的名称。
 * 解析结果的复用（heap 中按名称缓存）由调用方负责；本模块没有状态。
 */
import { hashString } from '@/lib/hash';

/** 名称签名所需的配置：项目前缀与校验 salt（9.2：salt 写在配置中）。 */
export interface NamingKey {
  readonly prefix: string;
  readonly salt: string;
}

/** 名称中除前缀与校验位之外的字段。 */
export interface NameFields {
  /** 来源 shard 名；私服没有 shard 时为 `x`。 */
  readonly source: string;
  /** 出生用途：简短的恢复与观察提示；spawn 固定为 `spn`。 */
  readonly purpose: string;
  /** 目标 shard 名；不跨 shard 时为 `x`。 */
  readonly target: string;
  /** 完整的出生 tick（Game.time），不取模。 */
  readonly tick: number;
  /** 同 tick 序号，在该 shard 的全部 spawn 间共享。 */
  readonly seq: number;
}

/** 前缀：小写字母开头，最多 8 个小写字母或数字。 */
const PREFIX = /^[a-z][a-z0-9]{0,7}$/;
/** shard 名：1–16 个字母或数字（官服 `shard0`、`shardSeason`，私服 `x`）。不含分隔符 `-` 与 `.`。 */
const SHARD = /^[A-Za-z0-9]{1,16}$/;
/** 出生用途：小写字母开头，最多 4 个小写字母或数字。 */
const PURPOSE = /^[a-z][a-z0-9]{0,3}$/;
/** 规范的 base36 非负整数：`0`，或不以 0 开头的小写 base36 串。 */
const BASE36 = /^(?:0|[1-9a-z][0-9a-z]*)$/;

/**
 * @description 计算校验位。
 * @param body 校验位之前的全部文本，不含末尾的 `-`。
 * @param salt 配置中的 salt。
 * @returns 一个 base36 字符（0–9、a–z）。
 */
const checkDigit = (body: string, salt: string): string => (hashString(body + salt) % 36).toString(36);

/**
 * @description 解析规范的 base36 非负整数。
 * @param text 待解析文本。
 * @returns 安全整数；不是规范写法或超出安全整数范围时为 undefined。
 */
const parseBase36 = (text: string): number | undefined => {
  if (!BASE36.test(text)) return undefined;
  const value = parseInt(text, 36);
  // 超过 2^53 的值无法精确往返，按非法处理。
  return Number.isSafeInteger(value) && value.toString(36) === text ? value : undefined;
};

/**
 * @description 检查签名配置：前缀符合格式、salt 为字符串。
 * @param key 签名配置。
 * @returns 无返回值。
 * @throws {TypeError} 前缀或 salt 不合法（配置错误）。
 */
const checkKey = (key: NamingKey): void => {
  if (!PREFIX.test(key.prefix) || typeof key.salt !== 'string') throw new TypeError('命名配置非法');
};

/**
 * @description 由字段生成带校验位的名称（9.2）。调用方负责分配不重复的序号并检查现有名称。
 * @param key 项目前缀与 salt。
 * @param fields 来源与目标 shard、出生用途、出生 tick 与同 tick 序号。
 * @returns 规范形式的名称。
 * @throws {TypeError} 配置或任一字段不合法（shard 含分隔符、用途过长、tick 或序号不是非负安全整数等）。
 * @example
 * formatName({ prefix: 'lv', salt: 's' }, { source: 'shard0', purpose: 'hv', target: 'x', tick: 75012345, seq: 2 });
 * // → 'lv-shard0-hv-x-18nrw9.2-<校验位>'
 */
export const formatName = (key: NamingKey, fields: NameFields): string => {
  checkKey(key);
  const { source, purpose, target, tick, seq } = fields;
  if (!SHARD.test(source) || !SHARD.test(target) || !PURPOSE.test(purpose)
    || !Number.isSafeInteger(tick) || tick < 0 || !Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError('名称字段非法');
  }
  const body = `${key.prefix}-${source}-${purpose}-${target}-${tick.toString(36)}.${seq.toString(36)}`;
  return `${body}-${checkDigit(body, key.salt)}`;
};

/**
 * @description 架构 11.3 的 sig(name)：名称符合命名规范、前缀为本项目且校验位正确时返回解析出的字段。不抛错。
 * 保底循环的应急名称（`fb-…`，5.7）字段数不同，总是不通过。
 * @param key 项目前缀与 salt；配置非法时一律不通过。
 * @param name 待校验的名称。
 * @returns 通过时为字段；格式、前缀或校验位不符时为 undefined。
 */
export const verifyName = (key: NamingKey, name: string): NameFields | undefined => {
  if (typeof name !== 'string' || !PREFIX.test(key.prefix) || typeof key.salt !== 'string') return undefined;
  const parts = name.split('-');
  if (parts.length !== 6) return undefined;
  const [prefix, source, purpose, target, stamp, check] = parts;
  if (prefix !== key.prefix || !SHARD.test(source) || !PURPOSE.test(purpose) || !SHARD.test(target)) return undefined;
  const dot = stamp.indexOf('.');
  if (dot < 0) return undefined;
  const tick = parseBase36(stamp.slice(0, dot));
  const seq = parseBase36(stamp.slice(dot + 1));
  if (tick === undefined || seq === undefined) return undefined;
  // 校验位之前的文本即名称去掉末尾的 "-<校验位>"；校验位为单个字符。
  if (check.length !== 1 || checkDigit(name.slice(0, name.length - 2), key.salt) !== check) return undefined;
  return { source, purpose, target, tick, seq };
};
