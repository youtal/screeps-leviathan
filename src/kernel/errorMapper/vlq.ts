/**
 * 文件摘要：Source Map v3 的 mappings 解码与按列查找，供 errorMapper 使用（设计见 docs/design/kernel/errorMapper.md）。
 *
 * 所属位置：src/kernel/errorMapper/，纯函数，无状态、无依赖；游戏运行时不能加载 npm 包，因此自行实现 Base64 VLQ。
 * 解码规则：每个段是 1、4 或 5 个相对值；生成列在每个 `;`（新生成行）处归零，只在行内累加；
 * 源文件索引、原始行、原始列与名称索引跨行延续累加。结果按生成行保存为紧凑的 Int32Array，
 * 每段 4 个整数 [生成列, 源文件索引, 原始行, 原始列]，只有 1 个值的段源文件索引记为 -1（无源码位置）。
 * 成本：与 mappings 长度成正比；调用方每个 global 至多解码一次。
 */

/** 每段在 Int32Array 中占用的整数个数。 */
const STRIDE = 4;

/** { [Base64 字符的码点]: 对应的 6 位值 }，非法字符为 -1。 */
const BASE64 = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i += 1) table[chars.charCodeAt(i)] = i;
  return table;
})();

/** 一个原始位置：源文件索引与 0 起算的行、列。 */
export interface OriginalPosition {
  readonly source: number;
  readonly line: number;
  readonly column: number;
}

/**
 * @description 解码 mappings 字段。
 * @param mappings Source Map 的 mappings 文本。
 * @returns 按生成行（0 起算）排列的段数组，每行一个 Int32Array，每段 4 个整数。
 * @throws {Error} 出现非法 Base64 字符、VLQ 未结束或段的值个数不是 1、4、5。
 */
export const decodeMappings = (mappings: string): Int32Array[] => {
  const lines: Int32Array[] = [];
  let row: number[] = [];
  let column = 0;
  let source = 0;
  let line = 0;
  let original = 0;
  // 当前段已读出的值个数与各值；名称索引只需推进位置，不保存。
  const values = [0, 0, 0, 0, 0];
  let count = 0;
  let value = 0;
  let shift = 0;

  /**
   * @description 结束当前段：按值个数更新累加状态并写入当前行。
   * @returns 无返回值。
   * @throws {Error} 值个数不是 0、1、4、5 或 VLQ 未结束。
   */
  const closeSegment = (): void => {
    if (shift !== 0) throw new Error('VLQ 未结束');
    if (count === 0) return;
    if (count !== 1 && count !== 4 && count !== 5) throw new Error(`段的值个数非法：${count}`);
    column += values[0];
    if (count === 1) {
      row.push(column, -1, 0, 0);
    } else {
      source += values[1];
      line += values[2];
      original += values[3];
      row.push(column, source, line, original);
    }
    count = 0;
  };

  for (let i = 0; i < mappings.length; i += 1) {
    const code = mappings.charCodeAt(i);
    if (code === 44 /* , */) { closeSegment(); continue; }
    if (code === 59 /* ; */) {
      closeSegment();
      lines.push(Int32Array.from(row));
      row = [];
      column = 0;
      continue;
    }
    const digit = code < 128 ? BASE64[code] : -1;
    if (digit < 0) throw new Error(`非法 Base64 字符：${mappings[i]}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    // 最低位是符号位。
    const decoded = value & 1 ? -(value >>> 1) : value >>> 1;
    if (count < values.length) values[count] = decoded;
    count += 1;
    value = 0;
    shift = 0;
  }
  closeSegment();
  lines.push(Int32Array.from(row));
  return lines;
};

/**
 * @description 在一个生成行中查找生成列不大于目标列的最近段。
 * @param lines decodeMappings 的结果。
 * @param line 生成行（0 起算）。
 * @param column 生成列（0 起算）。
 * @returns 原始位置；该行没有满足条件的段，或最近段没有源码位置时为 null。
 */
export const lookup = (lines: readonly Int32Array[], line: number, column: number): OriginalPosition | null => {
  const row = lines[line];
  if (!row || row.length === 0) return null;
  let low = 0;
  let high = row.length / STRIDE - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (row[mid * STRIDE] <= column) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0 || row[found * STRIDE + 1] < 0) return null;
  return { source: row[found * STRIDE + 1], line: row[found * STRIDE + 2], column: row[found * STRIDE + 3] };
};
