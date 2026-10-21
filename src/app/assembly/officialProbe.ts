/**
 * 文件摘要：M1 官服验证分支的测试夹具，由 assembly 仅在 pinkpunk/shard0 装配。
 * 使用真实上下文验证流水线、分区、旗帜切片、动态实例、熔断和恢复；没有运营职责。
 * 故障、备份和软重置均须控制台显式触发。故障最多持续 100 tick，到期经宿主 recover 自动恢复；
 * global reset 丢弃故障状态。测试数据只写 m1Probe 分区与 m1Economy 旗帜切片，固定一面 m1-check 旗帜。
 * 每 20 tick 记录一次摘要；计数放 heap，持久计数经 Accessor 标脏，重置后从持久值继续。
 * 临时命令与使用步骤见 docs/audit/2026-10-21-m1-official-validation.md；不得合并进 dev。
 */
import type { BootDefinition } from '@/contracts/boot';
import type { UnitSpec } from '@/contracts/memory';
import type { ModuleDefinition } from '@/contracts/module';
import type { Kernel } from '@/kernel/lifecycle';
import type { Profiler } from '@/kernel/profiler';
import { localX, localY, packLocal, packWorld, unpackWorld } from '@/lib/geometry';
import { hashString } from '@/lib/hash';
import { formatName, verifyName } from '@/lib/naming';

/** 固定名称避免测试实体与 profiler 标签无界增长。 */
const FLAG = 'm1-check';
type Counter = { ticks: number; last: number };
const COUNTER: UnitSpec<Counter> = {
  version: 1,
  /**
   * @description 创建测试计数。
   * @returns 初始纯数据。
   */
  initialize: () => ({ ticks: 0, last: 0 }),
  /**
   * @description 拒绝不属于本夹具版本的数据，避免覆盖已有内容。
   * @param _data 旧数据，不使用。
   * @param _fromVersion 旧版本，不接受迁移。
   * @returns 不返回。
   * @throws {Error} 不支持迁移。
   */
  migrate: (_data, _fromVersion) => { throw new Error('M1 测试数据版本不匹配'); },
};

/**
 * @description 限定官服夹具的账户与 shard，私服场景与其他账户不装配测试模块。
 * @returns 是否启用本夹具。
 */
export const officialProbeEnabled = (): boolean => Game.shard?.name === 'shard0'
  && Object.values(Game.spawns).some((spawn) => spawn.owner.username === 'pinkpunk');

/**
 * @description 创建本 kernel 实例的测试夹具。计数和故障只在闭包中存活，重装时由持久分区恢复计数。
 * @param profiler 本次装配的真实 profiler，用于控制台观察上一完整 tick 的计时。
 * @returns 模块清单、boot 包装器与宿主命令安装器。
 */
export const createOfficialProbe = (profiler: Profiler) => {
  let kernel: Kernel;
  let backup = false;
  let reset = false;
  let fault: { key: string; until: number } | undefined;
  let phase = '';
  let persisted: Counter | undefined;
  let economy = 0;
  let dependent = 0;
  let instance = 0;
  let setups = 0;
  let disposals = 0;
  let recovered = 0;
  let lastBackup = '未请求';
  let activeInstance = false;

  /**
   * @description 在指定进程注入可捕获的错误，检验真实熔断与源码映射；不触碰 Memory。
   * @param key 当前进程键。
   * @returns 无返回值。
   * @throws {Error} 指定故障在有效期内。
   */
  const maybeFail = (key: string): void => {
    if (fault?.key === key && Game.time < fault.until) throw new Error(`M1_EXPECTED_FAULT ${key}`);
  };

  const modules: readonly ModuleDefinition[] = [{
    id: 'm1Probe', tier: 'survival', priority: 0,
    /**
     * @description 安装持久计数与五阶段观察器，并在真实游戏对象上检查 lib 往返。
     * @param ctx 内核提供的模块上下文。
     * @returns 五阶段钩子。
     */
    setup(ctx) {
      setups += 1;
      const state = ctx.memory.partition('state', COUNTER);
      persisted = { ticks: state.get(['ticks'])!, last: state.get(['last'])! };
      const pos = Object.values(Game.spawns)[0].pos;
      const local = packLocal(pos.x, pos.y);
      const world = unpackWorld(packWorld(pos.roomName, pos.x, pos.y)!);
      const key = { prefix: 'm1', salt: 'official-test' };
      const name = formatName(key, { source: 'shard0', purpose: 'test', target: 'x', tick: Game.time, seq: 0 });
      if (localX(local) !== pos.x || localY(local) !== pos.y || world.room !== pos.roomName
        || world.x !== pos.x || world.y !== pos.y || hashString('leviathan') !== 3065891564
        || verifyName(key, name)?.tick !== Game.time) throw new Error('M1 lib 官服向量失败');
      ctx.log.success(`M1 setup：恢复计数 ${persisted.ticks}，last=${persisted.last}；geometry/hash/naming 通过`);
      return {
        /**
         * @description 开始本 tick 的阶段记录。
         * @returns 无返回值。
         */
        sense() { phase = 'sense'; },
        /**
         * @description 记录 plan。
         * @returns 无返回值。
         */
        plan() { phase += '>plan'; },
        /**
         * @description 记录 arbitrate。
         * @returns 无返回值。
         */
        arbitrate() { phase += '>arbitrate'; },
        /**
         * @description 记录 act。
         * @returns 无返回值。
         */
        act() { phase += '>act'; },
        /**
         * @description 完成五阶段并递增持久计数。
         * @returns 无返回值；分区标脏。
         */
        move() {
          phase += '>move';
          state.set(['ticks'], state.get(['ticks'])! + 1);
          state.set(['last'], Game.time);
          persisted = { ticks: state.get(['ticks'])!, last: state.get(['last'])! };
          if (Game.time % 20 === 0) ctx.log.debug(() => `M1 phases=${phase} count=${persisted!.ticks} remaining=${ctx.cpu.remaining().toFixed(2)}`);
        },
      };
    },
  }, {
    id: 'm1Fault', tier: 'survival', priority: 1,
    /**
     * @description 独立的单钩子生存层故障靶，避免其他成功钩子重置连续失败数。
     * @param _ctx 内核上下文，不使用。
     * @returns 故障靶钩子。
     */
    setup(_ctx) { return {
      /**
       * @description 注入生存层故障。
       * @returns 无返回值。
       * @throws {Error} 人工故障已启用。
       */
      act() { maybeFail('m1Fault'); },
    }; },
  }, {
    id: 'm1Economy', tier: 'economy', priority: 0, requires: ['m1Fault'],
    /**
     * @description 观察固定旗帜，验证实体切片与动态实例生命周期。
     * @param ctx 内核提供的模块上下文。
     * @returns sense 与 act 钩子。
     */
    setup(ctx) {
      const flags = ctx.flags.slice(COUNTER);
      return {
        /**
         * @description 按 m1-check 的存在增删一个实例。
         * @returns 无返回值。
         */
        sense() {
          const present = Game.flags[FLAG] !== undefined;
          if (present && !ctx.processes.has('flag')) {
            const slice = flags.of(FLAG);
            slice.set(['ticks'], slice.get(['ticks'])! + 1);
            slice.set(['last'], Game.time);
            ctx.processes.add('flag', (child) => {
              activeInstance = true;
              child.log.success('M1 flag 实例创建');
              return {
                /**
                 * @description 递增动态实例计数或注入实例故障。
                 * @returns 无返回值。
                 * @throws {Error} 实例故障已启用。
                 */
                act() { maybeFail(child.key); instance += 1; },
                /**
                 * @description 记录实例释放。
                 * @returns 无返回值。
                 */
                dispose() { disposals += 1; activeInstance = false; child.log.success('M1 flag 实例释放'); },
              };
            });
          } else if (!present && ctx.processes.has('flag')) {
            if (fault?.key === 'm1Economy:flag') fault = undefined;
            ctx.processes.remove('flag');
          }
        },
        /**
         * @description 记录经济层实际运行次数。
         * @returns 无返回值。
         */
        act() { economy += 1; },
      };
    },
  }, {
    id: 'm1Dependent', tier: 'economy', priority: 1, requires: ['m1Economy'], startPaused: true,
    /**
     * @description 默认暂停的依赖方，用于验证启停覆盖与依赖传播。
     * @param _ctx 内核上下文，不使用。
     * @returns 计数钩子。
     */
    setup(_ctx) { return {
      /**
       * @description 记录依赖方实际执行次数。
       * @returns 无返回值。
       */
      act() { dependent += 1; },
    }; },
  }];

  return {
    modules,
    /**
     * @description 保留真实 boot，随后在其特权阶段执行显式请求的备份或软重置；不清空存储。
     * @param original 真实 app.boot 定义。
     * @returns 测试用 boot 定义。
     */
    boot(original: BootDefinition): BootDefinition { return {
      /**
       * @description 连接真实 boot 与测试请求。
       * @param ctx 真实 BootContext。
       * @returns boot 钩子。
       */
      setup(ctx) {
        const hooks = original.setup(ctx);
        return {
          /**
           * @description 执行真实判定，然后推进有界的测试动作。
           * @returns 无返回值。
           */
          boot() {
            hooks.boot();
            if (fault && Game.time >= fault.until) {
              kernel.ops.recover(fault.key);
              ctx.log.success(`M1 故障到期自动恢复 ${fault.key}`);
              fault = undefined;
              recovered += 1;
            }
            if (backup) {
              lastBackup = ctx.port.backup();
              ctx.log.debug(`M1 backup=${lastBackup}`);
              backup = lastBackup === 'pending';
            }
            if (reset) { reset = false; ctx.port.softReset(); }
          },
        };
      },
    }; },
    /**
     * @description 安装测试命令；所有命令经真实 console 的隔离与结果格式化。
     * @param host 已装配的真实 kernel。
     * @returns 无返回值；安装 m1 命名空间。
     */
    install(host: Kernel): void {
      kernel = host;
      const registry = host.console('m1');
      registry.command('status', '测试计数、流水线、故障及 kernel 状态', () => ({
        tick: Game.time, phase, persisted, economy, dependent, instance, activeInstance, setups, disposals, recovered,
        fault: fault ?? null, backup: lastBackup, kernel: host.ops.status(),
      }));
      registry.command('profile', '上一完整 tick 的真实 profiler 快照', () => profiler.snapshot());
      registry.command('backup', '备份本 kernel 加载时的 Memory 到 80–89 页；覆盖旧备份，不清空 Memory', () => {
        if (fault) throw new Error('故障测试期间不启动备份');
        backup = true; return '下一 tick 开始备份';
      });
      registry.command('reset', '下一 tick 请求 bootPort 软重置', () => {
        if (fault || backup) throw new Error('先完成故障或备份测试');
        reset = true; return '下一 tick 软重置';
      });
      registry.command('fault', "fault('module'|'instance', 3..100)：注入故障，到期自动 recover", (target, ticks = 20) => {
        if (fault || backup) throw new Error('已有测试进行中');
        if (target !== 'module' && target !== 'instance') throw new Error('target 应为 module 或 instance');
        if (!Number.isInteger(ticks) || Number(ticks) < 3 || Number(ticks) > 100) throw new Error('ticks 应为 3..100');
        if (target === 'instance' && !activeInstance) throw new Error('先放置 m1-check 旗帜');
        fault = { key: target === 'module' ? 'm1Fault' : 'm1Economy:flag', until: Game.time + Number(ticks) + 1 };
        return fault;
      });
      registry.command('recover', '立即取消故障并调用真实 ops.recover', () => {
        if (fault) { host.ops.recover(fault.key); fault = undefined; recovered += 1; }
        return '已恢复';
      });
    },
  };
};
