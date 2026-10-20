/**
 * 文件摘要：kernel.intershard，InterShardMemory 的封装（设计见 docs/design/kernel/intershard.md，架构设计 6.9）。
 *
 * 所属位置：src/kernel/intershard/，kernel 内部模块，是唯一访问 InterShardMemory 的模块（架构 4.2）。
 * M1 只提供 bootPort 需要的特性检测与本 shard 清空（11.4 附加规则 2）；跨 shard 协议在 M5 补充。
 * 私服不提供 InterShardMemory（附录 A F7），所以每次调用时在注入的目标对象上检测，不在模块加载时读取全局。
 * 没有 heap 状态，也没有每 tick 的固定成本。
 */

/** InterShardMemory 中本模块用到的部分。 */
interface InterShardMemoryLike {
  /**
   * @description 写入本 shard 的那一份内容。
   * @param value 字符串内容。
   * @returns 无返回值。
   */
  setLocal(value: string): void;
}

/** kernel 内部接口。 */
export interface InterShardHost {
  /**
   * @description 判断运行环境是否提供 InterShardMemory。
   * @returns 提供时为 true。
   */
  available(): boolean;
  /**
   * @description 把本 shard 的内容写为空字符串；不可用时什么也不做。
   * @returns 无返回值。
   * @throws {*} 平台异常原样传播，由 boot 特权端口交给 boot。
   */
  clearLocal(): void;
}

/**
 * @description 创建 intershard 宿主；构造不读取平台。
 * @param target 安装全局对象的目标：游戏中为 globalThis，测试中为隔离对象。
 * @returns intershard 宿主接口。
 */
export const createInterShard = (target: object): InterShardHost => {
  /**
   * @description 取得目标对象上的 InterShardMemory。
   * @returns InterShardMemory；不存在时为 undefined。
   */
  const platform = (): InterShardMemoryLike | undefined => {
    const value = (target as { InterShardMemory?: unknown }).InterShardMemory;
    return value !== null && typeof value === 'object' ? value as InterShardMemoryLike : undefined;
  };
  return {
    /**
     * @description 判断运行环境是否提供 InterShardMemory。
     * @returns 提供时为 true。
     */
    available: () => platform() !== undefined,
    /**
     * @description 清空本 shard 的内容，语义见 InterShardHost.clearLocal。
     * @returns 无返回值。
     * @throws {*} 平台异常原样传播。
     */
    clearLocal() { platform()?.setLocal(''); },
  };
};
