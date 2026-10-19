/**
 * 文件摘要：kernel.memory 的单元序列化缓存与提交事务，设计见 docs/design/kernel/memory.md。
 * 首次全量编码，随后只编码脏单元；根文本通过缓存拼装，干净 tick 不写入。
 * 单元级隔离：校验失败的单元沿用最近一次合法编码写出，保持脏与待校验状态并告警一次，其余单元照常提交。
 * 验证与编码全部完成后才调用平台写入，成功后发布缓存、尺寸并清除已编码单元的脏状态；写入失败保留重试依据。
 * pending 在平台写入前设置，下一 tick 核对驱动是否实际保存，防止收尾拒绝造成永久丢写。
 */
import { validateJson } from './json';
import { type Runtime, type SizeSnapshot, unitId, warn } from './runtime';
import type { Space, Unit } from './unit';

/**
 * @description 拼装对象文本，仅对键做 JSON 转义；值必须已经编码。
 * @param pairs 按 Object.keys 顺序排列的键与已编码值的二元组。
 * @returns 与对应对象全量编码顺序一致的 JSON 文本。
 */
const objectText = (pairs: readonly (readonly [string, string])[]): string =>
  `{${pairs.map(([key, text]) => `${JSON.stringify(key)}:${text}`).join(',')}}`;

/**
 * @description 创建实例专属提交器，复用单元编码及其他根字段的缓存。
 * 缓存节省的是干净单元的数据遍历与编码；脏提交仍扫描单元索引并拼接整个根文本。
 * 所以脏提交并非 O(脏单元数)，也不意味着 RawMemory.set 的整串成本被消除。
 * @param state 当前 Memory 实例的运行状态。
 * @returns 无参数提交函数；写入口成功时返回 true，无变化时返回 false，失败时抛错。
 */
export const createCommitter = (state: Runtime): (() => boolean) => {
  // { [根字段名]: 非本命名空间字段的编码 }；这些数据没有可变能力，实例内只编码一次。
  const peers = new Map<string, string>();
  // 当前宿主入口没有 sys 写能力，首次编码后可一直复用；未来加入写能力时须同步失效此缓存。
  let sys: string | undefined;
  // 抽查游标跨 commit 轮转，避免总是检查前几个单元；未启用抽查时不额外编码。
  let audit = state.units.values();
  /**
   * @description 抽查未标脏单元、编码变化并提交；写入成功后发布缓存与尺寸，最后清脏。
   * @returns 调用 write 成功为 true，无变化为 false；驱动是否接受需下一 tick 确认。
   * @throws {Error} 实例不可用、发现未标脏修改、同 tick 重复写入或文本超限。
   * @throws {TypeError} 待编码数据不符合 JSON 约束。
   * @throws {*} 平台写入异常原样传播，脏状态保留以供重试。
   */
  return () => {
    state.check();
    // 开发抽查使用原始编码作基线，不冻结业务对象，也不把违规修改静默变成合法写入。
    for (let n = 0; n < Math.min(state.options.auditUnits ?? 0, state.units.size); n += 1) {
      let item = audit.next();
      if (item.done) { audit = state.units.values(); item = audit.next(); }
      if (item.done) break;
      const unit = item.value;
      if (!state.dirty.has(unit) && unit.encoded !== undefined) {
        validateJson(unit.record.data);
        if (JSON.stringify(unit.record) !== unit.encoded) throw new Error('检测到未标脏的 Memory 修改');
      }
    }
    // 抽查先于空提交返回，才能发现干净 tick 的违规写入；结构变化也可能没有脏单元。
    if (!state.structural && state.dirty.size === 0) return false;
    if (state.written) throw new Error('同一 tick 只能提交一次');
    // { [单元对象]: 尚未发布的新编码 }，写入失败时丢弃，不污染可重用缓存。
    const staged = new Map<Unit, string>();
    // 本次新进入隔离、待告警的单元；告警在重入保护内发出。
    const isolatedNow: Unit[] = [];
    for (const unit of state.units.values()) {
      if (unit.encoded === undefined || state.dirty.has(unit)) {
        // 只校验 update 修改过的单元：set/replace 写入前、加载/初始化/迁移发布前都已完整校验，
        // 重复遍历只增加描述符分配。校验通过才清除标记；失败时标记与脏状态保留，下一次提交继续校验。
        if (unit.needsValidation) {
          try { validateJson(unit.record.data); } catch (error) {
            // update 会在单元尚无基线时先编码，所以失败单元必有可沿用的合法编码；缺失说明前提被破坏。
            if (unit.encoded === undefined) throw error;
            if (!unit.isolated) { unit.isolated = true; isolatedNow.push(unit); }
            continue;
          }
          unit.needsValidation = false;
        }
        staged.set(unit, JSON.stringify(unit.record));
      }
    }
    // 只剩被隔离的单元待写时没有新内容可持久化，不写入；仍须告警首次隔离。
    if (staged.size === 0 && !state.structural) {
      for (const unit of isolatedNow) warn(state, `Memory 单元校验失败，沿用上一版编码：${unit.id}`);
      return false;
    }
    sys ??= JSON.stringify(state.data!.sys);
    const spaces = { sys: sys.length, part: 0, rooms: 0, creeps: 0, flags: 0 };
    // owner 可为 toString 等名字，无原型字典避免累计尺寸时误读继承成员。
    const owners = Object.create(null) as Record<string, number>;
    // { [空间名]: 本次拼装的空间文本 }；owner 尺寸为其单元包络长度之和，不含索引键。
    const texts = new Map<string, string>([['sys', sys]]);
    for (const space of ['part', 'rooms', 'creeps', 'flags'] as const satisfies readonly Space[]) {
      const groups = state.data![space];
      const text = objectText(Object.keys(groups).map((parent) => [parent,
        objectText(Object.keys(groups[parent]).map((key) => {
          const unit = state.units.get(unitId(space, parent, key))!;
          // 优先本次编码，其余（含被隔离单元）沿用已有编码；加载/注册确保每个根记录在 units 中存在。
          const encoded = staged.get(unit) ?? unit.encoded!;
          owners[unit.owner] = (owners[unit.owner] ?? 0) + encoded.length;
          return [key, encoded];
        })),
      ]));
      texts.set(space, text); spaces[space] = text.length;
    }
    // 按原根字段顺序保留其他命名空间；单元删除通过根表遍历自然排除，不复用旧结构串。
    const namespace = objectText(Object.keys(state.data!).map((key) => [key, texts.get(key)!]));
    const candidate = objectText(Object.keys(state.root).map((key) => {
      if (key === state.options.namespace) return [key, namespace];
      if (!peers.has(key)) peers.set(key, JSON.stringify(state.root[key]));
      return [key, peers.get(key)!];
    }));
    // 告警和写入口都不得回调访问器修改已编码数据；下一 tick 也会清除此保护。
    state.committing = true;
    try {
      for (const unit of isolatedNow) warn(state, `Memory 单元校验失败，沿用上一版编码：${unit.id}`);
      // 与平台一致按 JS 字符串 length 计量，不是 UTF-8 字节数；超限时不调用 write。
      if (candidate.length >= 1.8 * 1024 * 1024) warn(state, 'Memory 接近 2 Mi 字符上限');
      if (candidate.length > 2 * 1024 * 1024) throw new Error('Memory 超过 2 Mi 字符上限');
      const sizes: SizeSnapshot = Object.freeze({ total: candidate.length,
        spaces: Object.freeze(spaces), owners: Object.freeze(owners) });
      // 必须早于 write 保存确认依据：write 返回后驱动仍可能在 tick 收尾拒绝保存。
      state.pending = candidate;
      state.options.platform.write(candidate);
      // write 抛错不会到达此处，旧缓存与脏集合保留。成功后先发布所有基线，最后清脏。
      // pending 仍保留至下一 tick 确认；尺寸快照此时仅代表写入口成功，不代表驱动已保存。
      // 只清除本次成功编码的单元；被隔离单元保持脏与待校验状态，等待修正后再次提交。
      for (const [unit, encoded] of staged) { unit.encoded = encoded; unit.isolated = false; state.dirty.delete(unit); }
      state.sizes = sizes;
      state.structural = false;
      state.written = true;
      return true;
    } finally { state.committing = false; }
  };
};
