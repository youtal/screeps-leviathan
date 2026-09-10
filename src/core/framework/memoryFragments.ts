/**
 * 文件摘要：缓存 RawMemory 各顶层分区的原生 JSON 字符串，并组装下一次完整写入。
 * 本文件只处理字符串片段，不决定 dirty、checkpoint、插件版本或 tick 生命周期。
 * 首次创建会遍历现有 Memory；后续 prepare 仅 stringify 调用者提交的变化分区。
 * accept 必须在 RawMemory 写入成功后调用，使片段基线与已提交数据保持一致。
 */
import type { FrameworkMemory, FrameworkState } from './types';
import type { ProfilerMemory } from '../profiler';

type RootMemory = object & { leviathan?: FrameworkMemory };

/** 直接采用 JSON.stringify 语义，只拒绝无法成为独立 JSON 值片段的 undefined 结果。 */
const serialize = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Unable to serialize Memory value');
  return result;
};

/**
 * 为一个已经解析的 Memory 根创建片段缓存。
 * prepare 返回候选文本与确认函数，避免存储写入失败后错误更新本地提交基线。
 */
export const createMemoryFragments = (rootMemory: RootMemory) => {
  const root = new Map<string, string>();
  const plugins = new Map<string, string>();
  let versions = '{}';
  let health = '{}';
  let receipts = '[]';
  let profiler = '{}';

  for (const [key, value] of Object.entries(rootMemory))
    if (key !== 'leviathan') root.set(key, serialize(value));
  const existing = rootMemory.leviathan;
  if (existing) {
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
    let nextVersions = versions;
    let nextHealth = health;
    let nextReceipts = receipts;
    let nextProfiler = profiler;
    const nextPlugins = new Map(plugins);

    if (changes.framework) {
      nextVersions = serialize(changes.framework.pluginVersions);
      nextHealth = serialize(changes.framework.pluginHealth);
      nextReceipts = serialize(changes.framework.intentReceipts);
    }
    if (changes.profiler) nextProfiler = serialize(changes.profiler);
    for (const [id, value] of changes.plugins)
      nextPlugins.set(id, serialize(value));

    /** 键名单独编码，已序列化的值片段直接拼接，避免再次遍历其对象树。 */
    const rootEntries = [...root].map(
      ([key, value]) => JSON.stringify(key) + ':' + value
    );
    const pluginEntries = [...nextPlugins].map(
      ([key, value]) => JSON.stringify(key) + ':' + value
    );
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

  return { prepare };
};
