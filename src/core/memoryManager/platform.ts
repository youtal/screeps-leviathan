/**
 * 文件摘要：MemoryManager 的默认平台端口实现，直连 Screeps 的 RawMemory 与 Segment API。
 *
 * 模块位置：core/memoryManager 的平台适配层，由 createMemoryManager 在未注入端口时使用；
 * 测试通过注入端口完整替代它，因此本文件不参与单元测试的断言路径。
 *
 * 输入输出：readRaw/writeRaw 对应 RawMemory.get/set 的完整字符串读写；readSegments/
 * writeSegment 对应 RawMemory.segments 的按页读写；activeSegments/activateSegments
 * 对应 RawMemory.getActiveSegments/setActiveSegments。所有方法都是薄包装，不做缓存与转换。
 *
 * 运行时约束：setActiveSegments 只是"请求激活"，被请求的页要到下一 tick 才可读；
 * RawMemory.set 接收完整字符串，超限由引擎拒绝，因此容量检查在管理器侧完成。
 * 本文件不访问 Game、Memory 全局对象，也不写 Memory 根，避免与游戏自身的内存对象耦合。
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
