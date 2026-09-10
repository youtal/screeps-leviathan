/**
 * 文件摘要：保存插件注册状态并验证依赖图，生成确定性的生命周期执行列表。
 * Map 保留注册顺序；稳定 Kahn 拓扑排序只在注册集合改变时重算，tick 热路径复用结果。
 * 执行期间变更由 Kernel 使用候选注册表在下一 tick 原子应用。
 */
import type { LeviathanPlugin } from './types';
import { validId } from './memoryInterceptor';

/** 注册记录与启用状态分离；停用保留图节点及 Memory，是否参与执行由 Kernel 决定。 */
export interface PluginEntry {
  plugin: LeviathanPlugin;
  enabled: boolean;
}
/**
 * 创建仅驻留 global heap 的注册表；global reset 后由 app 重新提交注册描述。
 * 缓存排序结果换取 tick 热路径免排序，变更成本集中到边界 validate；失败不发布候选。
 */
export const createPluginRegistry = () => {
  /** entries 保存已接受记录，sorted 保存同一批记录的依赖顺序，二者必须同时更新。 */
  let entries = new Map<string, PluginEntry>();
  let sorted: PluginEntry[] = [];
  /** 验证整个候选图，包含停用插件；服务唯一性不能因临时停用而放宽。 */
  const validate = (candidate: Map<string, PluginEntry>): PluginEntry[] => {
    const owners = new Map<string, string>();
    for (const [id, { plugin }] of candidate) {
      const m = plugin.manifest;
      if (
        !validId(id) ||
        id === 'framework' ||
        !Number.isInteger(m.version) ||
        m.version < 1 ||
        !Number.isFinite(m.priority ?? 0)
      )
        throw new Error('Invalid plugin manifest: ' + id);
      const persistence = m.persistence;
      if (!persistence && plugin.migrate)
        throw new Error('Migration requires persistence: ' + id);
      if (
        persistence &&
        (!['critical', 'checkpoint'].includes(persistence.layer) ||
          (persistence.checkpointInterval !== undefined &&
            (!Number.isInteger(persistence.checkpointInterval) ||
              persistence.checkpointInterval < 1 ||
              persistence.layer !== 'checkpoint')))
      )
        throw new Error('Invalid persistence config: ' + id);
      for (const dep of m.requires ?? []) {
        if (!candidate.has(dep))
          throw new Error('Missing dependency: ' + id + ' -> ' + dep);
      }
      for (const name of m.provides ?? []) {
        if (!validId(name) || owners.has(name))
          throw new Error('Duplicate or invalid service: ' + name);
        owners.set(name, id);
      }
    }
    // Kahn 的剩余节点表；必需依赖先检查存在性，可选依赖不存在时视为已满足。
    const remaining = new Map(candidate);
    const result: PluginEntry[] = [];
    // 每轮扫描剩余节点并排序 ready，只取一个，最坏约 O(VE + V² log V)。
    // 插件规模较小且仅变更时运行，采用直观实现；稳定 sort 使同优先级保持注册次序。
    while (remaining.size) {
      const ready = [...remaining.values()].filter(({ plugin }) =>
        [
          ...(plugin.manifest.requires ?? []),
          ...(plugin.manifest.optional ?? []),
        ].every((id) => !remaining.has(id))
      );
      ready.sort(
        (a, b) =>
          (b.plugin.manifest.priority ?? 0) - (a.plugin.manifest.priority ?? 0)
      );
      if (!ready.length) {
        // 无 ready 时每个剩余节点都有剩余依赖；沿边前进必重复，以重复段报告实际环。
        const path: string[] = [];
        let id = remaining.keys().next().value as string;
        while (!path.includes(id)) {
          path.push(id);
          const m = remaining.get(id)!.plugin.manifest;
          id = [...(m.requires ?? []), ...(m.optional ?? [])].find((dep) =>
            remaining.has(dep)
          )!;
        }
        throw new Error(
          'Dependency cycle: ' +
            [...path.slice(path.indexOf(id)), id].join(' -> ')
        );
      }
      const chosen = ready[0];
      result.push(chosen);
      remaining.delete(chosen.plugin.manifest.id);
    }
    return result;
  };
  /** 先计算后赋值，任何验证异常都保留旧 entries/sorted；调用方此后不再修改候选。 */
  const replace = (candidate: Map<string, PluginEntry>) => {
    const next = validate(candidate);
    entries = candidate;
    sorted = next;
  };
  return {
    replace,
    // 复制条目防止 enable 原地更新穿透旧状态；插件描述已由注册入口复制，故共享其引用。
    copy: () => new Map([...entries].map(([id, e]) => [id, { ...e }])),
    ordered: () => sorted.slice(),
  };
};
