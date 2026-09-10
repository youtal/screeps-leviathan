/**
 * 文件摘要：缓存 RawMemory 各顶层分区的原生 JSON 字符串，并组装下一次完整写入。
 * 本文件只处理字符串片段，不决定 dirty、checkpoint、插件版本或 tick 生命周期。
 * 首次创建会遍历现有 Memory；后续 prepare 仅 stringify 调用者提交的变化分区。
 * accept 必须在 RawMemory 写入成功后调用，使片段基线与已提交数据保持一致。
 *
 * 所属模块：core/framework 的内部组件，只由 memoryInterceptor 在首次成功解析 Memory 后构造，
 * 调用链为 begin → createMemoryFragments、flush → prepare → accept，不是公共出口。
 * 输入是已解析的 Memory 根对象（构造时全量遍历一次）与 prepare 提交的变化分区；
 * 输出是一次写入所需的完整 JSON 文本和确认函数；本文件不读写 RawMemory，副作用留给调用方。
 * 状态是各分区片段的 heap 字符串基线，生命周期与 MemoryInterceptor 的常驻根一致，
 * global reset 后随实例重建，因此不会把上一轮 global 的文本当作当前基线。
 */
import type { FrameworkMemory, FrameworkState } from './types';
import type { ProfilerMemory } from '../profiler';

/** 交叉类型：插件 Memory 的根字段名由业务决定，内核只额外关心可选的 leviathan 命名空间。
 *  用 object 而不是 Memory，避免片段管理器依赖 Screeps 全局声明，测试可直接传普通对象。 */
type RootMemory = object & { leviathan?: FrameworkMemory };

/** 直接采用 JSON.stringify 语义，只拒绝无法成为独立 JSON 值片段的 undefined 结果。 */
// undefined、函数和 Symbol 会被 stringify 判为不可序列化；此时抛错好过把 "undefined"
// 片段拼进 Memory 让整份 JSON 非法。NaN/Infinity→null、循环引用抛 TypeError 等行为
// 完全沿用原生语义，内核不额外转换，插件必须按 JSON 数据模型设计自己的持久状态。
const serialize = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Unable to serialize Memory value');
  return result;
};

/**
 * 为一个已经解析的 Memory 根创建片段缓存。
 * prepare 返回候选文本与确认函数，避免存储写入失败后错误更新本地提交基线。
 * 构造期是唯一一次全量遍历：根级未知字段逐个 stringify，此后每 tick 只处理调用者提交的
 * 变化分区，成本由 O(整棵 Memory 树) 降到 O(变化分区) + O(输出文本长度)。
 * 这一步的失败（例如循环引用或非法值）会抛给 memoryInterceptor.begin，被 Kernel 记为加载失败。
 */
export const createMemoryFragments = (rootMemory: RootMemory) => {
  /** 根级未知字段片段：内核不解释内容，只原样保留，例如其他工具写入的 Memory 字段。 */
  const root = new Map<string, string>();
  /** 插件持久分区片段：键为插件 id，只为已声明持久化的插件建立条目。 */
  const plugins = new Map<string, string>();
  // leviathan.framework 四个字段各自的文本基线。分开缓存使 framework 与 profiler 能按
  // 各自的节奏提交：前者随失败/熔断等关键状态，后者按 checkpoint 间隔。
  // receipts 是 schema 版本 1 的兼容槽位，Kernel 不再写入内容，正常情况保持 '[]'。
  let versions = '{}';
  let health = '{}';
  let receipts = '[]';
  let profiler = '{}';

  // Object.entries 会为根级每个字段生成键值对，这里刻意排除 leviathan：
  // 它的各字段由更细粒度的片段分别管理，先整体序列化再拆解只会重复遍历。
  for (const [key, value] of Object.entries(rootMemory))
    if (key !== 'leviathan') root.set(key, serialize(value));
  const existing = rootMemory.leviathan;
  if (existing) {
    // 已有命名空间时，用已提交文本初始化基线，使下一次 flush 只需拼接无需重算。
    versions = serialize(existing.framework.pluginVersions);
    health = serialize(existing.framework.pluginHealth);
    receipts = serialize(existing.framework.intentReceipts);
    profiler = serialize(existing.framework.profiler);
    for (const [id, value] of Object.entries(existing.plugins))
      plugins.set(id, serialize(value));
  }

  const prepare = (changes: {
    framework?: FrameworkState;
    profiler?: ProfilerMemory;
    plugins: ReadonlyMap<string, unknown>;
  }) => {
    // changes 用可选字段表达"本次要提交哪些分区"：framework/profiler 缺省表示该分区未变化，
    // 继续沿用已提交片段；plugins 声明为 ReadonlyMap 表示只读入参，值用 unknown 是因为
    // 内核不解释插件数据结构，只把它交给 JSON.stringify。
    // 候选值先放局部变量：序列化抛错或存储写入失败时已提交基线保持旧值，
    // 与 memoryInterceptor.flush "写入成功后才 accept" 的两阶段协议对应。
    let nextVersions = versions;
    let nextHealth = health;
    let nextReceipts = receipts;
    let nextProfiler = profiler;
    // 复制已提交基线再改：nextPlugins 上的 set 不会触碰 plugins 本身，
    // 因此 accept 之前基线与候选互不影响。
    const nextPlugins = new Map(plugins);

    // 三个 framework 字段属于同一次 FrameworkState 提交，必须整体更新；
    // profiler 单独判定，它按 profilerCheckpointInterval 到期才需要重算。
    if (changes.framework) {
      nextVersions = serialize(changes.framework.pluginVersions);
      nextHealth = serialize(changes.framework.pluginHealth);
      nextReceipts = serialize(changes.framework.intentReceipts);
    }
    if (changes.profiler) nextProfiler = serialize(changes.profiler);
    // 只覆盖本次变化的分区，未出现在 Map 中的插件继续沿用已提交片段。
    for (const [id, value] of changes.plugins)
      nextPlugins.set(id, serialize(value));

    /**
     * 键名单独编码，已序列化的值片段直接拼接，避免再次遍历其对象树。
     * 键名必须走 JSON.stringify：Memory 字段名可能含引号或反斜杠，手写拼接会破坏 JSON。
     * 拼接成本是 O(输出总长度) 的字符串操作，Screeps 只提供 RawMemory.set(完整字符串)，
     * 因此即使大部分片段未变也无法做字节级增量写，只能压缩到"不重复序列化对象树"。
     */
    const rootEntries = [...root].map(
      ([key, value]) => JSON.stringify(key) + ':' + value
    );
    const pluginEntries = [...nextPlugins].map(
      ([key, value]) => JSON.stringify(key) + ':' + value
    );
    // leviathan 外壳以字面量拼装：schemaVersion 1 必须与 memoryInterceptor 的校验值一致，
    // 字段顺序固定，Map 又保持插入序，因此相同状态总会生成相同文本，便于比对 RawMemory。
    // 内核字段全部显式写出，未知字段不会混进 leviathan，避免 memoryInterceptor 的 schema 校验失败。
    rootEntries.push(
      '"leviathan":{' +
        '"schemaVersion":1,' +
        '"framework":{' +
        '"pluginVersions":' +
        nextVersions +
        ',"pluginHealth":' +
        nextHealth +
        ',"intentReceipts":' +
        nextReceipts +
        ',"profiler":' +
        nextProfiler +
        '},"plugins":{' +
        pluginEntries.join(',') +
        '}}'
    );

    return {
      value: '{' + rootEntries.join(',') + '}',
      /** 只更新字符串引用和 Map 内容，不再执行序列化。 */
      // 先 clear 再回填保持同一 Map 实例，避免每 tick 重新分配；此时不做任何校验，
      // 因为调用方只在 port.write 成功返回后才会执行 accept。
      accept: (): void => {
        versions = nextVersions;
        health = nextHealth;
        receipts = nextReceipts;
        profiler = nextProfiler;
        plugins.clear();
        for (const [id, value] of nextPlugins) plugins.set(id, value);
      },
    };
  };

  // 只暴露 prepare：片段基线与 accept 语义都封装在闭包内，外部无法直接改写已提交文本。
  return { prepare };
};
