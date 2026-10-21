/**
 * 文件摘要：app.ops，运维命令（设计见 docs/design/app/ops.md，架构设计 5.1、5.5、5.8、13.3）。
 *
 * 所属位置：src/app/ops/，由 app.assembly 在每次装配 kernel 后创建；以 ops 为命名空间注册控制台命令：
 * status、pause、resume、unset、recover、log（help 由 kernel.console 自动提供）。
 * 命令把运维意图转为对 kernel 宿主接口 KernelOps 与日志根对象的调用，不理解业务语义，不直接读写 Memory。
 * 命令在主循环之后运行（kernel.console 的平台事实），启停与恢复因此在下一 tick 生效。
 * kernel 不可用时（抛错重建、冷却期），ops.status 经离线处理函数返回入口状态（审计 LC-04）；其他命令返回桩结果。
 * 状态：无。每个 kernel 实例对应一次 createOps，注册器与闭包随 kernel 实例存在。
 */
import type { LogLevel } from '@/contracts/log';
import type { Kernel, KernelStatus, ModuleStatus } from '@/kernel/lifecycle';
import { LOG_LEVELS, type LogRoot } from '@/kernel/logger';
import { OPS_NAMESPACE } from '@/kernel/process';

/** 入口的状态，由 main.ts 的入口闭包提供（内核设计第 6 节"入口状态"）。 */
export interface EntryStatus {
  readonly time: number;
  /** 停用冷却的剩余 tick；不在冷却期时为 0。 */
  readonly cooldown: number;
  /** 连续失败次数（抛错，或暂停超限后的软重置）。 */
  readonly crashes: number;
  /** 连续计为 degraded 的 tick 数。 */
  readonly degraded: number;
  /** 连续暂停的 tick 数。 */
  readonly paused: number;
  /** 最近一次失败；尚未失败过时为 undefined。 */
  readonly lastFailure: { readonly tick: number; readonly message: string } | undefined;
}

/** createOps 的依赖，由装配方注入。 */
export interface OpsDeps {
  readonly kernel: Kernel;
  /** 日志根对象：ops.log 修改它的默认开关。 */
  readonly logRoot: LogRoot;
  /**
   * @description 读取入口状态；跨 kernel 实例存在，不引用 kernel。
   * @returns 入口状态。
   */
  entryStatus(): EntryStatus;
}

/** 模块状态的中文名。 */
const STATE_TEXT: Readonly<Record<ModuleStatus['state'], string>> = Object.freeze({
  pending: '未 setup', running: '运行', paused: '暂停', blocked: '依赖暂停', broken: '熔断', failed: '初始化失败',
});

/**
 * @description 把数值格式化为两位小数；undefined 显示为 -。
 * @param value 数值。
 * @returns 文本。
 */
const num = (value: number | undefined): string => (value === undefined ? '-' : value.toFixed(2));

/**
 * @description 生成入口状态的文本。
 * @param s 入口状态。
 * @returns 一行或两行文本。
 */
export const formatEntry = (s: EntryStatus): string => {
  const head = `入口：tick ${s.time}，冷却剩余 ${s.cooldown} tick，连续失败 ${s.crashes}，连续 degraded ${s.degraded}，连续暂停 ${s.paused}`;
  return s.lastFailure ? `${head}\n最近一次失败：tick ${s.lastFailure.tick}，${s.lastFailure.message}` : head;
};

/**
 * @description 生成 kernel 状态的文本：概要一行，每个模块一行。
 * @param s kernel 状态快照。
 * @returns 多行文本。
 */
export const formatStatus = (s: KernelStatus): string => {
  const head = `tick ${s.tick}，健康 ${s.health ?? '-'}，模式 ${s.mode.mode}/${s.mode.strength}，版本 ${s.release}，`
    + `Memory ${s.memory}，B ${num(s.budget)}，R ${num(s.reserve)}`;
  const lines = s.modules.map((m) => `${m.id}（${m.tier}）${STATE_TEXT[m.state]}`
    + `${m.switch ? `，覆盖 ${m.switch}` : m.startPaused ? '，默认暂停' : ''}`
    + `，耗用 ${num(m.cost)}，连续落选 ${m.starve}，实例 ${m.instances}（熔断 ${m.brokenInstances}）`
    + `${m.reason ? `，未启动：${m.reason}` : ''}`);
  return [head, ...(lines.length ? lines : ['（没有模块）'])].join('\n');
};

/**
 * @description 校验参数为非空字符串。
 * @param value 参数。
 * @param name 参数名，用于错误消息。
 * @returns 字符串。
 * @throws {TypeError} 不是非空字符串。
 */
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} 须为非空字符串`);
  return value;
};

/**
 * @description 在 kernel 的 ops 命名空间注册运维命令，并为 status 登记离线处理函数。
 * @param deps kernel、日志根对象与入口状态读取函数。
 * @returns 无返回值。
 */
export const createOps = (deps: OpsDeps): void => {
  const { kernel } = deps;
  const ops = kernel.console(OPS_NAMESPACE);

  ops.command('status', 'ops.status([模块 id])：kernel 与各模块的状态；kernel 不可用时显示入口状态', (id?: unknown) => {
    const status = kernel.ops.status();
    if (id === undefined) return `${formatStatus(status)}\n${formatEntry(deps.entryStatus())}`;
    const module = status.modules.find((m) => m.id === text(id, '模块 id'));
    if (!module) throw new Error(`未知模块 ${String(id)}`);
    return formatStatus({ ...status, modules: [module] });
  });
  ops.offline('status', () => formatEntry(deps.entryStatus()));

  ops.command('pause', 'ops.pause(id)：运维暂停一个非生存层模块，下一 tick 生效', (id: unknown) => {
    kernel.ops.setSwitch(text(id, '模块 id'), 'pause');
    return `已暂停 ${String(id)}，下一 tick 生效`;
  });
  ops.command('resume', 'ops.resume(id)：运维恢复一个模块（覆盖清单的默认暂停），下一 tick 生效', (id: unknown) => {
    kernel.ops.setSwitch(text(id, '模块 id'), 'run');
    return `已恢复 ${String(id)}，下一 tick 生效`;
  });
  ops.command('unset', 'ops.unset(id)：清除运维覆盖，恢复清单默认值，下一 tick 生效', (id: unknown) => {
    kernel.ops.setSwitch(text(id, '模块 id'), undefined);
    return `已清除 ${String(id)} 的运维覆盖，下一 tick 生效`;
  });
  ops.command('recover', 'ops.recover(key)：清除模块或实例（<模块 id>:<实例键>）的熔断，不重新 setup', (key: unknown) => {
    kernel.ops.recover(text(key, '进程键'));
    return `已清除 ${String(key)} 的熔断，下一 tick 起参与调度`;
  });
  ops.command('log', 'ops.log(level, on[, scope])：修改日志默认开关，或一个模块/实例的覆盖（on 为 null 时恢复默认）；只存于 heap',
    (level: unknown, on: unknown, scope?: unknown) => {
      if (!LOG_LEVELS.includes(level as LogLevel)) throw new TypeError(`level 须为 ${LOG_LEVELS.join('、')} 之一`);
      if (scope === undefined) {
        if (typeof on !== 'boolean') throw new TypeError('修改默认开关时 on 须为 true 或 false');
        deps.logRoot.setDefault(level as LogLevel, on);
        return `日志默认开关 ${String(level)} = ${String(on)}`;
      }
      if (typeof on !== 'boolean' && on !== null) throw new TypeError('on 须为 true、false 或 null');
      kernel.ops.logger(text(scope, '作用域')).configLevel({ [level as LogLevel]: on ?? undefined });
      return `${String(scope)} 的日志 ${String(level)} = ${on === null ? '默认' : String(on)}`;
    });
};
