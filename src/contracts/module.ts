/**
 * 文件摘要：模块清单与模块定义（contracts 层，设计见 docs/design/contracts/README.md 第 2 节，进程表规则见架构设计 5.1）。
 *
 * 各模块导出 ModuleDefinition，由 app.assembly 汇总交给 kernel；kernel 按清单排序、调用 setup，并按阶段调用钩子。
 * 阶段钩子与动态实例表定义在 context.ts。本文件只含类型声明，没有运行时代码。
 */
import type { ModuleContext, ModuleId, PhaseHooks } from './context';
import type { Tier } from './cpu';

/** 构建期确定的模块清单，kernel 在每个 global 启动时据此做一次稳定拓扑排序。 */
export interface ModuleManifest {
  readonly id: ModuleId;
  /** 硬依赖：缺失或熔断时本模块一同暂停。 */
  readonly requires?: readonly ModuleId[];
  /** 软依赖：只影响拓扑排序。 */
  readonly optional?: readonly ModuleId[];
  readonly tier: Tier;
  /** 同层内的顺序，越小越先。 */
  readonly priority: number;
}

/** 模块定义。 */
export interface ModuleDefinition extends ModuleManifest {
  /** 每个 global 调用一次，返回本模块的阶段钩子。 */
  setup(ctx: ModuleContext): PhaseHooks;
}
