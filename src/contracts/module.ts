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
  /**
   * 没有运维覆盖时是否暂停，默认 false（架构 5.5、13.3：新领域以暂停状态上线，经 `ops.resume(id)` 启用）。
   * 暂停只跳过钩子，仍执行 setup；生存层模块不能暂停，此项对其无效（docs/design/app/ops.md 第 3 节）。
   */
  readonly startPaused?: boolean;
}

/** 模块定义。 */
export interface ModuleDefinition extends ModuleManifest {
  /**
   * @description 每个 global 调用一次：声明分区与切片、解析所需服务，并返回本模块的阶段钩子。
   * @param ctx 本模块的上下文，在整个 global 生命周期内稳定，可由钩子闭包持有。
   * @returns 本模块实现的阶段钩子。
   */
  setup(ctx: ModuleContext): PhaseHooks;
}
