/**
 * 文件摘要
 *
 * 模块角色：core/memoryManager 对接 Screeps 的平台适配层，将宿主存储操作集中在一处。
 *
 * 主要功能：提供主存储文本读写、Segment 读写、当前可见页面查询和下一轮页面激活请求。
 *
 * 实现过程：createScreepsPlatform 返回 MemoryPlatform 方法，将调用分别转给 RawMemory 的
 * get、set、segments 与 setActiveSegments，激活前复制输入 ID 数组。
 *
 * 技术要点：创建适配器本身不访问存储，调用方法才产生读写或激活副作用；没有内部缓存。
 * activeSegments 返回当前可见页面，申请激活不表示本 tick 就能读取，新页面的等待由管理器处理。
 */
import type { MemoryPlatform } from './types';

export const createScreepsPlatform = (): MemoryPlatform => ({
  readRaw: () => RawMemory.get(),
  writeRaw: (value) => RawMemory.set(value),
  readSegments: () => RawMemory.segments,
  writeSegment: (id, value) => {
    RawMemory.segments[id] = value;
  },
  // Screeps 只提供 setActiveSegments 与当前可见的 segments 对象：可见性以
  // `RawMemory.segments` 的键为准，请求激活的页要到下一 tick 才出现在这里。
  activeSegments: () => Object.keys(RawMemory.segments).map(Number),
  activateSegments: (ids) => {
    RawMemory.setActiveSegments([...ids]);
  },
});
