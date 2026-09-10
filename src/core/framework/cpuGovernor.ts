/**
 * 文件摘要：提供 tick 内 CPU 准入检查，为 Memory 写回和后处理保留预算。
 * 使用 tickLimit 为硬边界、limit 为普通插件边界；低 bucket 暂缓普通插件。
 * 此组件不能抢占 JavaScript 函数，长任务必须主动检查 remaining 并分批运行。
 */
import type { CpuBudget } from './types';
/**
 * 工厂仅保留注入函数与阈值，检查时重新取得 Game.cpu，不缓存跨 tick CPU 数值。
 * 默认值供配置缺省及测试环境使用；每次检查为常数时间，仍要支付 getUsed 的采样开销。
 */
export const createCpuGovernor = (
  getGame: () => Game,
  reserveCpu = 5,
  minBucket = 1000
): CpuBudget => {
  if (
    !Number.isFinite(reserveCpu) ||
    reserveCpu < 0 ||
    !Number.isFinite(minBucket) ||
    minBucket < 0
  ) {
    throw new Error('Invalid CPU budget');
  }
  /** 扣掉收尾预算后截断到 0；无 tickLimit 时回退 limit，最后回退 20。 */
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
    // 检查通过不等于资源预留；实际执行可能超预算，尤其不能抢占单个同步长函数。
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
