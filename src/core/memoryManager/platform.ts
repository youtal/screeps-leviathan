/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 对接 Screeps 的平台适配层，是项目中唯一调用 RawMemory 的位置。
 *
 * 主要功能：提供主存储文本读写与当前 tick 查询。
 *
 * 实现过程：createScreepsPlatform 返回 MemoryPlatform，readRaw/writeRaw 转给 RawMemory.get/set，
 * getTick 读取 Game.time。
 *
 * 技术要点：创建适配器不访问存储，调用方法才产生读写。RawMemory.set 在官方 driver 中只检查
 * 类型与长度并保存引用，计费开销与文本大小无关；绝不读取全局 Memory，否则引擎会在 tick
 * 结束时额外 JSON.stringify 整棵 Memory。不提供任何 Segment 能力。
 */
import type { MemoryPlatform } from './types';

export const createScreepsPlatform = (): MemoryPlatform => ({
  readRaw: () => RawMemory.get(),
  writeRaw: (value) => RawMemory.set(value),
  getTick: () => Game.time,
});
