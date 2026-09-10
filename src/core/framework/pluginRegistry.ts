/**
 * 文件摘要：保存插件注册状态并验证依赖图，生成确定性的生命周期执行列表。
 * Map 保留注册顺序；稳定 Kahn 拓扑排序只在注册集合改变时重算，tick 热路径复用结果。
 * 执行期间变更由 Kernel 使用候选注册表在下一 tick 原子应用。
 *
 * 所属模块：core/framework 的内核组件，由 createFramework 创建并独占调用（register/enable/
 * unregister 只排队命令，循环边界再调用 replace）；不从 framework/index 导出。
 * 输入是候选注册表 Map<id, PluginEntry>，输出是校验通过的依赖顺序数组（ordered）；
 * 校验失败通过同步抛错上报，由 Kernel 记为整批命令失败，旧注册表保持不变。
 * 状态仅在 heap：已接受记录 entries 与缓存的排序结果 sorted，global reset 后由 app 重新注册。
 */
import type { LeviathanPlugin } from './types';
// 复用 Memory 拦截器的命名空间校验：注册通过的 id 必须能安全地作为 Memory 键，
// 两处共用同一实现可避免规则漂移（原型链保留键、空串或非法字符）。
import { validId } from './memoryInterceptor';

/** 注册记录与启用状态分离；停用保留图节点及 Memory，是否参与执行由 Kernel 决定。 */
// 该结构对外导出，Kernel 用它构造候选表；enabled 必须在候选副本上修改，不能直接改这里。
export interface PluginEntry {
  plugin: LeviathanPlugin;
  enabled: boolean;
}
/**
 * 创建仅驻留 global heap 的注册表；global reset 后由 app 重新提交注册描述。
 * 缓存排序结果换取 tick 热路径免排序，变更成本集中到边界 validate；失败不发布候选。
 * 注册顺序由 Map 插入序承载：它既是同优先级插件的次序依据，也是 Kernel 遍历顺序。
 */
export const createPluginRegistry = () => {
  /** entries 保存已接受记录，sorted 保存同一批记录的依赖顺序，二者必须同时更新。 */
  let entries = new Map<string, PluginEntry>();
  let sorted: PluginEntry[] = [];
  /**
   * 验证整个候选图，包含停用插件；服务唯一性不能因临时停用而放宽。
   * 只在注册集合变化时运行，因此选择"先全量校验、后一次性发布"，而不是在 tick 中增量修补：
   * 停用插件同样参与校验，依赖存在性、id 与服务唯一性在注册时就已成立，启停命令只需改标志位；
   * 一旦校验失败则整批命令作废，不会出现半安装的依赖图。
   */
  const validate = (candidate: Map<string, PluginEntry>): PluginEntry[] => {
    const owners = new Map<string, string>();
    for (const [id, { plugin }] of candidate) {
      const m = plugin.manifest;
      // 'framework' 被内核用于自身诊断与 Profiler 标签（plugin.<id>.* 与 framework.*），
      // 保留该 id 避免插件健康记录、日志归属和标签互相混淆。
      // version 是正整数 Memory 版本号，不是语义化发布版本；priority 必须有限，否则排序不稳定。
      if (
        !validId(id) ||
        id === 'framework' ||
        !Number.isInteger(m.version) ||
        m.version < 1 ||
        !Number.isFinite(m.priority ?? 0)
      )
        throw new Error('Invalid plugin manifest: ' + id);
      const persistence = m.persistence;
      // migrate 只在持久分区升级时才有意义：没有持久化声明的迁移函数永远不会被调用。
      if (!persistence && plugin.migrate)
        throw new Error('Migration requires persistence: ' + id);
      // 与 memoryInterceptor.begin 的运行时校验重复，但这里的失败会整批回滚命令，
      // 而不是等到某个 tick 的 begin 才中断；两者共同保证非法配置进不了执行阶段。
      if (
        persistence &&
        (!['critical', 'checkpoint'].includes(persistence.layer) ||
          (persistence.checkpointInterval !== undefined &&
            (!Number.isInteger(persistence.checkpointInterval) ||
              persistence.checkpointInterval < 1 ||
              persistence.layer !== 'checkpoint')))
      )
        throw new Error('Invalid persistence config: ' + id);
      // 必需依赖必须已注册（允许当前停用）；缺失时整个候选批次失败，Kernel 保留旧注册表。
      for (const dep of m.requires ?? []) {
        if (!candidate.has(dep))
          throw new Error('Missing dependency: ' + id + ' -> ' + dep);
      }
      // 服务名全局独占：重名会让 services.get 的结果取决于注册顺序，故在校验期拒绝。
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
      // 就绪判定同时看 requires 与 optional：两者都已出队（或 optional 本来就不存在）才视为就绪。
      const ready = [...remaining.values()].filter(({ plugin }) =>
        [
          ...(plugin.manifest.requires ?? []),
          ...(plugin.manifest.optional ?? []),
        ].every((id) => !remaining.has(id))
      );
      // 降序排列，ready[0] 即当前可执行集合中优先级最高者；同优先级由稳定排序保持注册序。
      ready.sort(
        (a, b) =>
          (b.plugin.manifest.priority ?? 0) - (a.plugin.manifest.priority ?? 0)
      );
      if (!ready.length) {
        // 无 ready 时每个剩余节点都有剩余依赖；沿边前进必重复，以重复段报告实际环。
        const path: string[] = [];
        // 任取一个剩余节点出发：剩余节点数有限且每步都留在剩余集合内，循环必然终止。
        let id = remaining.keys().next().value as string;
        while (!path.includes(id)) {
          path.push(id);
          // 非空断言：id 来自 remaining（或下面 find 到存在于 remaining 的依赖），必然可查。
          const m = remaining.get(id)!.plugin.manifest;
          // 非空断言：节点不就绪说明至少有一个依赖仍在 remaining 中，find 必有结果。
          id = [...(m.requires ?? []), ...(m.optional ?? [])].find((dep) =>
            remaining.has(dep)
          )!;
        }
        // 从首次出现处截取，输出的是真实环而不是进入环之前的路径。
        throw new Error(
          'Dependency cycle: ' +
            [...path.slice(path.indexOf(id)), id].join(' -> ')
        );
      }
      // 取走一个 ready 节点后重新扫描：实现简单且能保证 priority 只在依赖满足后参与比较。
      const chosen = ready[0];
      result.push(chosen);
      // 用 manifest.id 删除：注册入口保证 Map 键与它一致；若两者不一致，这里会删不掉节点，
      // 下一轮又会选中同一节点而空转，因此该不变式必须由注册路径维持。
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
    // 复制是 O(V) 且只在命令批次边界调用，不进入每 tick 热路径。
    copy: () => new Map([...entries].map(([id, e]) => [id, { ...e }])),
    // 只复制数组外壳：元素与内部记录是同一对象，调用方必须保持只读（Kernel 只遍历不改写）。
    ordered: () => sorted.slice(),
  };
};
