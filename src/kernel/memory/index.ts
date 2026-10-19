/**
 * 文件摘要：kernel.memory 的宿主装配入口，设计见 docs/design/kernel/memory.md。
 * 构造阶段不读取平台；宿主先 beginTick，再按 boot 判定显式初始化缺失的项目命名空间，最后 commit。
 * 分区和实体能力只向宿主发布 owner 绑定入口，业务侧使用 contracts 中的窄接口。
 * 生命周期状态由闭包持有，无全局单例；dispose 后所有旧能力失效。
 */
import type { ProjectMarker } from '@/contracts/boot';
import { createCommitter } from './commit';
import { createEntities } from './entities';
import { createPartitions } from './partitions';
import { beginTick, createRuntime, initialize, type MemoryOptions, type MemoryPlatformPort, type TickFacts } from './runtime';

export { takeoverMemory } from './runtime';
export type { MemoryOptions, MemoryPlatformPort, SizeSnapshot, TickFacts } from './runtime';

/**
 * @description 创建绑定游戏全局 RawMemory 的平台端口。按架构 4.2，只有 kernel.memory 可以访问 RawMemory，
 * 所以装配方通过此函数取得端口，自身不触碰 RawMemory。read/write 每次调用时读取当前 tick 的全局 RawMemory，不缓存平台对象。
 * @param warn 容量告警的输出函数。
 * @returns 游戏环境的 Memory 平台端口。
 */
export const createGamePlatform = (warn: (message: string) => void): MemoryPlatformPort => ({
  target: globalThis,
  /**
   * @description 读取当前 tick 的原始 Memory 文本。
   * @returns RawMemory.get()。
   */
  read: () => RawMemory.get(),
  /**
   * @description 写入完整根文本。
   * @param text 已校验并编码的根文本。
   * @returns 无返回值。
   * @throws {Error} 平台拒绝写入（例如超过 2 MB）。
   */
  write: (text) => RawMemory.set(text),
  warn,
});

/**
 * @description 每个 global 由宿主创建一个实例；各子工厂共享同一 Runtime，缓存随实例保留。
 * 返回的是宿主能力集合，不能整体注入业务模块；业务只能获得绑定 owner 的窄接口。
 * @param options 平台端口及存储身份配置，构造阶段不读取平台。
 * @returns 独立的 Memory 宿主能力集合，须先 beginTick 再使用存储能力。
 * @throws {TypeError} 配置名称、签名、schema 或抽查数量非法。
 */
export const createMemory = (options: MemoryOptions) => {
  const state = createRuntime(options);
  const entities = createEntities(state);
  const commit = createCommitter(state);
  return {
    /**
     * @description tick 起点接管平台并更新事实，须早于任何原生 Memory 读取。
     * @param facts 当前 tick 时间及实体事实。
     * @returns empty 表示本项目命名空间缺失、待显式初始化（其他根键只读保留），ready 表示数据可用。
     * @throws {Error} 实例不可用、tick 非法、接管过晚或读取加载失败。
     */
    beginTick: (facts: TickFacts) => beginTick(state, facts),
    /**
     * @description 宿主完成启动判定后加入项目命名空间，保留其他根键，不清空已有数据或立即写回。
     * @param marker 经宿主授权的项目标记。
     * @returns 无返回值；创建根并等待 commit。
     * @throws {Error} 实例不可初始化、命名空间已存在或标记非法。
     */
    initialize: (marker: ProjectMarker) => initialize(state, marker),
    /**
     * @description 绑定模块身份，限制工厂只能申请该 owner 下的分区。
     * @param owner 模块身份。
     * @returns 缓存的分区工厂。
     * @throws {Error} 实例不可用或 owner 非法。
     */
    partitions: createPartitions(state),
    /**
     * @description 取得 owner 绑定的实体私有空间；core 不通过此入口发布。
     * @param owner 模块身份。
     * @returns rooms、creeps、flags 三种实体空间入口。
     * @throws {Error} 实例不可用、owner 非法或为 core。
     */
    entities: entities.entities,
    /**
     * @description 在宿主准入后执行实体回收及迁移，预算在同一 tick 累计。
     * @param limit 本 tick 累计扫描记录上限，默认 50。
     * @returns 本次实际扫描记录数。
     * @throws {Error} 实例不可用、预算非法或迁移失败。
     */
    maintain: entities.maintain,
    /**
     * @description 提交变化并缓存编码结果；驱动是否接受在下一 tick 确认。
     * @returns 写入口成功为 true，无变化为 false。
     * @throws {Error} 数据非法、超限、重复写入、实例不可用或平台写入失败；保留重试状态。
     */
    commit,
    /**
     * @description 以 O(1) 成本读取最近成功写入口的尺寸快照，不重新编码数据。
     * @returns 缓存尺寸；首次成功写入前各项为零。
     * @throws {Error} 实例未准备好、已销毁或正在提交。
     */
    sizes: () => { state.check(); return state.sizes; },
    /**
     * @description 判断存储是否可用：实例未销毁、未加载失败，且本项目命名空间已加载或已初始化。不抛错。
     * @returns 可用时为 true；空存储待初始化、加载失败或已销毁时为 false。
     */
    ready: () => state.active && state.failure === undefined && state.data !== undefined,
    /**
     * @description 判断加载是否已失败并锁存；失败后本实例不可再用，须等新的 global 或重建实例。
     * @returns 加载失败时为 true。
     */
    failed: () => state.failure !== undefined,
    /**
     * @description 撤销本实例能力，不清空平台文本、不自动提交未保存修改。
     * 外部仍持有的访问器会保留其闭包引用，但 active 闸门保证不可再使用。
     * @returns 无返回值；所有旧能力失效，可重复调用。
     * @throws {Error} 在告警或写入回调期间尝试销毁实例。
     */
    dispose() {
      if (state.committing) throw new Error('提交期间不可销毁 Memory');
      state.active = false;
      for (const unit of state.units.values()) unit.active = false;
      state.units.clear(); state.records.clear(); state.dirty.clear();
      state.root = {}; state.data = undefined;
    },
  };
};
