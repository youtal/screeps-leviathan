/**
 * 文件摘要：kernel.bootPort，boot 特权端口的实现（设计见 docs/design/kernel/bootPort.md，架构设计 5.5、5.6、6.7、11.4、11.8）。
 *
 * 所属位置：src/kernel/bootPort/，kernel 内部模块，只由 kernel.lifecycle 使用；实现 contracts 的 BootPort。
 * 端口只执行操作，不理解游戏含义：何时备份、能否清空、写入什么模式都由 app.boot 依据闸门决定。
 * kernel 只检查可机械判断的前置条件：端口只在 boot 钩子运行期间有效；清空只能在本 kernel 实例的普通模块 setup 之前。
 * 每 tick 输出两项状态供 lifecycle 与入口使用：本 tick 是否为暂停 tick（备份返回 pending 或登记软重置），
 * 以及是否登记了软重置。boot 钩子抛错时，本 tick 的软重置登记作废。
 * 状态：备份进度、端口开关、本 tick 的标志与本实例签发过的最大 epoch 保存在闭包中，随 kernel 实例存在；
 * 软重置后新实例从头开始，epoch 改由加载时的标记延续。
 */
import type { BackupState, BootPort, ProjectMarker } from '@/contracts/boot';
import type { GamePort, MemoryHost } from '@/kernel/context';
import type { InterShardHost } from '@/kernel/intershard';
import type { SegmentsHost } from '@/kernel/segments';
import { BACKUP_VERSION, createBackup } from './backup';

export { BACKUP_CAPACITY, BACKUP_CHUNK, BACKUP_VERSION } from './backup';

/** 创建 bootPort 的依赖，由 kernel.lifecycle 注入。 */
export interface BootPortDeps {
  readonly memory: MemoryHost;
  readonly segments: SegmentsHost;
  readonly interShard: InterShardHost;
  readonly game: GamePort;
  /** 装配身份：项目标记的 sig 与 schema。 */
  readonly identity: { readonly signature: string; readonly schema: number };
  /** 构建时注入的版本号，写入新建的项目标记。 */
  readonly release: string;
  /**
   * @description 本 kernel 实例的普通模块是否尚未 setup；只有此时允许清空。
   * @returns 尚未 setup 时为 true。
   */
  canClear(): boolean;
}

/** lifecycle 使用的宿主接口。 */
export interface BootPortHost {
  /** 交给 BootContext 的端口；boot 钩子运行期间之外调用任何方法都抛错。 */
  readonly port: BootPort;
  /**
   * @description 在端口开放期间运行 boot 钩子；先清零本 tick 的暂停标志，结束后（含抛错）关闭端口。
   * 钩子抛错时，本 tick 登记的软重置作废（boot 失败的 tick 不采信判定结果）。
   * @param hook boot 钩子。
   * @returns 无返回值。
   * @throws {*} 钩子的异常原样传播。
   */
  run(hook: () => void): void;
  /**
   * @description 本 tick 是否为暂停 tick：boot 调用 backup 得到 pending，或登记了软重置。
   * @returns 暂停时为 true。
   */
  paused(): boolean;
  /**
   * @description boot 是否在本 kernel 实例内登记过软重置。
   * @returns 登记过为 true。
   */
  resetRequested(): boolean;
}

/**
 * @description 创建 bootPort；构造不读取平台。
 * @param deps Memory、segments、intershard、游戏端口、身份、版本号与清空条件。
 * @returns 端口与 lifecycle 使用的状态查询。
 */
export const createBootPort = (deps: BootPortDeps): BootPortHost => {
  const { memory, game } = deps;
  let open = false;
  let pausedNow = false;
  let reset = false;
  // 本实例经 initialize 或 clearMemory 签发过的最大 epoch，0 表示尚未签发；只用于保证 epoch 只增不减。
  let issued = 0;
  const backup = createBackup({
    text: memory.loadedText,
    time: game.time,
    writer: deps.segments.writer('backup', BACKUP_VERSION),
    reader: deps.segments.reader('backup'),
  });

  /**
   * @description 检查端口是否处于开放期间。
   * @returns 无返回值。
   * @throws {Error} 不在 boot 钩子运行期间。
   */
  const guard = (): void => { if (!open) throw new Error('boot 特权端口只在 boot 阶段有效'); };

  /**
   * @description 生成 kernel 负责的项目标记初值；指纹与模式为占位值，由 boot 在同一 tick 经 sys 写入（6.7）。
   * @param epoch 新标记的纪元号。
   * @returns 完整的项目标记。
   */
  const markerFor = (epoch: number): ProjectMarker => ({
    sig: deps.identity.signature, schema: deps.identity.schema, shard: game.shard(), epoch,
    lastRun: game.time(), release: deps.release,
    fp: { rooms: [], spawnIds: [], creepCount: 0 },
    mode: { mode: 'AMBIGUOUS', strength: 'medium', since: game.time(), evidence: [] },
  });

  /**
   * @description 把 epoch 候选值规范为非负整数。
   * @param value 候选值。
   * @returns 非负安全整数原样返回，否则为 0。
   */
  const count = (value: unknown): number => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0);

  /**
   * @description 取得清空前的 epoch：加载时标记、本实例已签发与当前 sys 三者的最大值，不合法的按 0 计。
   * 当前 sys 在提交时才校验，heap 中可能暂存 boot 写入的非法值，只读它会使 epoch 回退（bootPort 设计第 3 节"epoch 只增不减"）。
   * @returns 原 epoch。
   */
  const previousEpoch = (): number => Math.max(count(memory.summary().marker?.epoch), issued,
    memory.ready() ? count(memory.sys().get(['epoch'])) : 0);

  const port: BootPort = {
    /**
     * @description 读取本 kernel 实例加载时原始 Memory 的概要，语义见 BootPort.summary。
     * @returns 深冻结的概要。
     * @throws {Error} 不在 boot 阶段调用。
     */
    summary() { guard(); return memory.summary(); },
    /**
     * @description 推进备份，语义见 BootPort.backup；返回 pending 的 tick 为暂停 tick。
     * @returns 备份进度。
     * @throws {Error} 不在 boot 阶段调用。
     */
    backup(): BackupState {
      guard();
      const state = backup();
      if (state === 'pending') pausedNow = true;
      return state;
    },
    /**
     * @description 在 Memory 为 empty 时加入本项目命名空间，epoch 为 1，语义见 BootPort.initialize。
     * @returns 无返回值。
     * @throws {Error} 不在 boot 阶段调用，或 Memory 不是 empty（已就绪、加载失败）。
     */
    initialize() { guard(); memory.initialize(markerFor(1)); issued = Math.max(issued, 1); },
    /**
     * @description 整体清空并以原 epoch + 1 重建项目标记，语义见 BootPort.clearMemory。
     * @returns 无返回值。
     * @throws {Error} 不在 boot 阶段调用，或本 kernel 实例的普通模块已 setup（须先软重置）。
     */
    clearMemory() {
      guard();
      if (!deps.canClear()) throw new Error('普通模块已 setup，清空 Memory 前须先软重置');
      const epoch = previousEpoch() + 1;
      memory.clear(markerFor(epoch));
      issued = epoch;
    },
    /**
     * @description 清空本 shard 的 InterShardMemory，语义见 BootPort.clearInterShard。
     * @returns 无返回值。
     * @throws {Error} 不在 boot 阶段调用。
     * @throws {*} 平台异常原样传播。
     */
    clearInterShard() { guard(); deps.interShard.clearLocal(); },
    /**
     * @description 登记软重置：本 tick 为暂停 tick，入口在下一 tick 前重建 kernel，语义见 BootPort.softReset。
     * @returns 无返回值。
     * @throws {Error} 不在 boot 阶段调用。
     */
    softReset() { guard(); reset = true; pausedNow = true; },
  };

  return {
    port,
    /**
     * @description 在端口开放期间运行 boot 钩子，语义见 BootPortHost.run。
     * @param hook boot 钩子。
     * @returns 无返回值。
     * @throws {*} 钩子的异常原样传播。
     */
    run(hook) {
      pausedNow = false;
      open = true;
      const resetBefore = reset;
      try {
        hook();
      } catch (error) {
        // boot 失败的 tick 不采信判定结果：本 tick 的软重置登记作废，下一 tick boot 在同一实例中重新判定。
        // 否则"登记软重置后抛错"的 boot 会使入口每 tick 重建 kernel 并完整解析 Memory，且这样的 tick 计为
        // degraded 而非 paused，不受暂停上限与冷却约束（第二轮审计 SR-01）。
        reset = resetBefore;
        throw error;
      } finally { open = false; }
    },
    /**
     * @description 本 tick 是否为暂停 tick。
     * @returns 暂停时为 true。
     */
    paused: () => pausedNow,
    /**
     * @description 是否登记过软重置。
     * @returns 登记过为 true。
     */
    resetRequested: () => reset,
  };
};
