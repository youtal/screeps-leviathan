/**
 * 文件摘要：lib.hash，稳定的字符串哈希（设计见 docs/design/lib/hash.md，架构设计 4.5、9.2、12.2）。
 *
 * 所属位置：src/lib/hash/，lib 层的无状态纯函数，任何层都可以直接导入。
 * 输出 32 位无符号整数，用于名称校验位（lib.naming）、周期任务错峰 `(Game.time + hash(id)) % N` 与按键分片。
 * 稳定性约束：校验位随名称持久存在于游戏世界中（creep、spawn 名称跨 global reset 与版本保留），
 * 所以算法一经发布就不能改变；需要不同分布时新增函数，不修改本函数。
 * 算法：FNV-1a 32 位逐 UTF-16 码元累乘，再做 MurmurHash3 的 fmix32 收尾。FNV-1a 的低位扩散较弱，
 * 而调用方常取小模数（36、错峰周期 N），收尾混合使相近输入（相邻序号、相邻 tick）的低位也均匀分布。
 * 成本：每个码元一次异或与一次 Math.imul，不分配对象；名称长度约 30 个字符。没有模块级状态。
 */

/** FNV-1a 32 位的初始值（offset basis）。 */
const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a 32 位的乘数（FNV prime）。 */
const FNV_PRIME = 0x01000193;

/**
 * @description 计算字符串的稳定哈希：FNV-1a 32 位加 fmix32 收尾，结果与运行环境无关。
 * 按 UTF-16 码元计算，不做 UTF-8 编码；同一字符串在任何 V8 版本中结果相同。
 * @param text 输入字符串，可为空串。
 * @returns 0 到 2^32 − 1 之间的整数。
 * @example
 * const phase = (Game.time + hashString(id)) % 10; // 错峰：phase 为 0 的 tick 执行
 */
export const hashString = (text: string): number => {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    // Math.imul 按 32 位有符号整数相乘并截断，避免浮点乘法丢失低位。
    h = Math.imul(h, FNV_PRIME);
  }
  // fmix32：两轮移位异或与乘法，使每个输入位影响全部输出位。
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  // >>> 0 把有符号结果转为无符号，取模时不会得到负数。
  return h >>> 0;
};
