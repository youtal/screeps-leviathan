/**
 * 文件摘要：kernel.segments 的页格式：一行页头 JSON、一个换行符、原样正文（设计见 docs/design/kernel/segments.md 第 3 节）。
 *
 * 正文不做 JSON 编码，避免转义放大体积；页头本身由 JSON.stringify 生成，不含换行符，所以第一个换行符就是分隔点。
 * 解析不抛错：页头缺失、无法解析或字段类型不符都返回 null，由调用方按空页处理（6.8 安全规则 2）。
 * 本文件只有纯函数，没有状态。
 */

/** 平台单页上限：100 × 1024 个字符（附录 A F9；driver runtime.js 按字符串 length 检查）。 */
export const SEG_PAGE_LIMIT = 100 * 1024;

/** 页头：数据版本、owner（store 名）、generation、epoch、批次内序号与批次页数。 */
export interface PageHeader {
  readonly v: number;
  readonly o: string;
  readonly g: number;
  readonly e: number;
  readonly i: number;
  readonly n: number;
}

/** 解析后的页：页头与原样正文。 */
export interface Page {
  readonly header: PageHeader;
  readonly body: string;
}

/**
 * @description 判断值是否为非负安全整数。
 * @param value 待判断的值。
 * @returns 是非负安全整数时为 true。
 */
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * @description 生成整页文本。字段顺序固定，便于外部工具按前缀识别。
 * @param header 页头。
 * @param body 原样正文。
 * @returns 页头 JSON、换行符与正文拼接的文本。
 */
export const encodePage = (header: PageHeader, body: string): string =>
  `${JSON.stringify({ v: header.v, o: header.o, g: header.g, e: header.e, i: header.i, n: header.n })}\n${body}`;

/**
 * @description 解析整页文本；从未写过的页（空串）与外来格式都返回 null。
 * @param text 平台载入的页内容。
 * @returns 页头字段齐全且类型合法时返回页；否则为 null。
 */
export const decodePage = (text: string): Page | null => {
  const split = text.indexOf('\n');
  if (split <= 0) return null;
  let header: unknown;
  try { header = JSON.parse(text.slice(0, split)); } catch { return null; }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return null;
  const { v, o, g, e, i, n } = header as Record<string, unknown>;
  if (!isCount(v) || typeof o !== 'string' || !isCount(g) || !isCount(e) || !isCount(i) || !isCount(n) || i >= n) return null;
  return { header: { v, o, g, e, i, n }, body: text.slice(split + 1) };
};
