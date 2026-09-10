/**
 * 文件摘要：提供 tick 内 CPU 准入检查，为 Memory 写回和后处理保留预算。
 * 使用 tickLimit 为硬边界、limit 为普通插件边界；低 bucket 暂缓普通插件。
 * 此组件不能抢占 JavaScript 函数，长任务必须主动检查 remaining 并分批运行。
 *
 * 所属模块：core/framework 的内核组件，由 createFramework 用 options 阈值构造，同时用于
 * 插件激活准入、tick 三阶段准入和意图提交预算；属于内部实现，不从 framework/index 导出。
 * 输入为 getGame 与两个阈值，输出为 types.ts 的 CpuBudget 协议（remaining/admit）闭包。
 * 组件不持有跨 tick 状态、不读写 Memory，因此 global reset 后无需恢复；代价是每次查询
 * 都重新采样 Game.cpu，用即时性换取"预算判断不会过期"。
 */
// import type 编译后被擦除：本组件在运行时只依赖注入的 getGame，不引入任何模块级依赖。
import type { CpuBudget } from './types';
/**
 * 工厂仅保留注入函数与阈值，检查时重新取得 Game.cpu，不缓存跨 tick CPU 数值。
 * 默认值供配置缺省及测试环境使用；每次检查为常数时间，仍要支付 getUsed 的采样开销。
 * getGame 而不是直接捕获 Game：Screeps 每 tick 刷新 Game 与其中的游戏对象，闭包只有在
 * 调用时取当前值才能读到本 tick 的 cpu 字段，测试与模拟环境也借此注入自己的 Game。
 * reserveCpu 是留给 tick 收尾（tickEnd、Memory 写回）的预算，minBucket 是普通插件放宽准入
 * 所需的 bucket 下限；两者都必须有限且非负，0 表示对应边界不预留余量。
 * 阈值非法时在 createFramework 构造期同步抛错：这属于配置错误，不进入运行时 safeMode，
 * 也避免 NaN/负数让准入判断退化为恒真或恒假。
 */
export const createCpuGovernor = (
  getGame: () => Game,
  reserveCpu = 5,
  minBucket = 1000
): CpuBudget => {
  // Number.isFinite 同时排除 NaN 与 ±Infinity；0 合法，表示该边界不留余量。
  if (
    !Number.isFinite(reserveCpu) ||
    reserveCpu < 0 ||
    !Number.isFinite(minBucket) ||
    minBucket < 0
  ) {
    throw new Error('Invalid CPU budget');
  }
  /**
   * 扣掉收尾预算后截断到 0；无 tickLimit 时回退 limit，最后回退 20。
   * tickLimit 是本 tick 实际可用的上限：bucket 为空时引擎允许透支到更高额度，此时它高于
   * limit；以它作硬边界，关键插件才可能在额度内越过常规 limit。
   * limit 是常规上限，官方运行时始终存在，?? 兜底只服务于注入精简 Game 的测试环境。
   * 结果截断为非负，便于调用方直接用 > 0 判定；这里同样不缓存，避免读到过期预算。
   */
  const remaining = () => {
    const cpu = getGame().cpu;
    return Math.max(
      0,
      (cpu.tickLimit ?? cpu.limit ?? 20) - cpu.getUsed() - reserveCpu
    );
  };
  return {
    remaining,
    // 关键插件可以使用 bucket 提供的额外预算，但不能跨过 remaining 的收尾边界。
    // 普通插件另需 bucket 达到 minBucket 且 getUsed 未触及 limit 减预留，两条同时成立才准入。
    // critical 默认 false，是唯一策略开关：为 true 时只保留 remaining 这一条硬边界。
    // 检查通过不等于资源预留；实际执行可能超预算，尤其不能抢占单个同步长函数。
    // 一次 admit 最多采样两次 getUsed（remaining 内一次、返回表达式一次），换来与收尾边界
    // 一致的口径；单次采样很便宜，但调用方仍不应在紧循环里逐条意图反复查询。
    // bucket 缺省按 10000（bucket 上限）处理，使精简模拟环境默认通过 bucket 门槛。
    admit: (critical = false) => {
      const cpu = getGame().cpu;
      if (remaining() <= 0) return false;
      return (
        critical ||
        ((cpu.bucket ?? 10000) >= minBucket &&
          cpu.getUsed() < (cpu.limit ?? 20) - reserveCpu)
      );
    },
  };
};
