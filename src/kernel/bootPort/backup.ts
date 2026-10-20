/**
 * 文件摘要：kernel.bootPort 的 Memory 备份状态机（设计见 docs/design/kernel/bootPort.md 第 3 节，架构设计 11.8）。
 *
 * 把本 kernel 实例加载时的原始 Memory 文本切分写入 segment 备份区（页 80–89），全部写出后回读比对，一致才算完成。
 * 每次 backup() 推进一步：
 *   idle → writing：切分并提交全部页（segments 每 tick 最多写出 5 页）；
 *   writing → verifying：待写页为 0（已在之前的 commit 中交给 RawMemory）后登记激活请求；
 *   verifying → done：下一 tick 读到全部页，页头的 g/i/n 与正文都与快照一致；
 *   不一致时整批重写一次（回到 writing），再不一致为 failed。
 * 只在全部写出后才请求激活，避免读到本批尚未覆盖的旧页；代价是比"写出当 tick 即请求"多一个 tick。
 * 状态：随 kernel 实例存在；done 与 failed 都保持到实例销毁，软重置后新实例从 idle 重新开始。
 */
import type { BackupState } from '@/contracts/boot';
import { type PageReader, type PageWriter, SEG_PAGE_LIMIT, STORES } from '@/kernel/segments';

/** 备份的数据版本，写入页头 v。 */
export const BACKUP_VERSION = 1;
/**
 * 每页正文的长度上限：单页上限减去页头余量。页头形如 {"v":1,"o":"backup","g":…,"e":…,"i":9,"n":10}，
 * g 与 e 即使是 16 位整数也不超过 90 个字符，留 128 个字符的余量。
 */
export const BACKUP_CHUNK = SEG_PAGE_LIMIT - 128;
/** 备份区容量：10 页约 1,022,720 个字符，小于 Memory 的 2 Mi 字符上限，超出时备份失败。 */
export const BACKUP_CAPACITY = BACKUP_CHUNK * STORES.backup.pages.length;

/** 备份状态机的依赖。 */
export interface BackupDeps {
  /**
   * @description 本 kernel 实例加载时的原始文本。
   * @returns 原始文本；平台读取失败时为 undefined。
   */
  text(): string | undefined;
  /**
   * @description 当前 tick，作为快照的 generation。
   * @returns Game.time。
   */
  time(): number;
  readonly writer: PageWriter;
  readonly reader: PageReader;
}

/**
 * @description 创建备份状态机；构造不读取平台。
 * @param deps 原始文本、时间与 backup store 的读写器。
 * @returns 每次调用推进一步的 backup 函数。
 */
export const createBackup = (deps: BackupDeps): (() => BackupState) => {
  let phase: 'idle' | 'writing' | 'verifying' | 'done' | 'failed' = 'idle';
  // 本次快照切分的正文，按页序排列；只在 writing/verifying 期间持有。
  let chunks: string[] = [];
  let generation = 0;
  let retried = false;

  /**
   * @description 提交整批备份页。
   * @returns 全部排队成功为 true；有页被拒绝（理论上不会发生）为 false。
   */
  const submit = (): boolean => chunks.every((body, i) =>
    deps.writer.submit(STORES.backup.pages[i], { g: generation, i, n: chunks.length }, body) === 'queued');

  /**
   * @description 比对已读到的备份页与快照。
   * @returns 全部一致为 true；有页未载入为 'pending'；否则为 false。
   */
  const verify = (): boolean | 'pending' => {
    let same = true;
    for (let i = 0; i < chunks.length; i += 1) {
      const page = deps.reader.read(STORES.backup.pages[i]);
      if (page === 'pending') return 'pending';
      if (page === 'empty' || page.header.v !== BACKUP_VERSION || page.header.g !== generation
        || page.header.i !== i || page.header.n !== chunks.length || page.body !== chunks[i]) same = false;
    }
    return same;
  };

  /**
   * @description 结束备份并释放快照切片。
   * @param result 终态。
   * @returns 终态。
   */
  const finish = (result: 'done' | 'failed'): BackupState => { phase = result; chunks = []; return result; };

  return () => {
    if (phase === 'done' || phase === 'failed') return phase;
    if (phase === 'idle') {
      const text = deps.text();
      if (text === undefined || text.length > BACKUP_CAPACITY) return finish('failed');
      if (text.trim() === '') return finish('done');
      chunks = [];
      for (let start = 0; start < text.length; start += BACKUP_CHUNK) chunks.push(text.slice(start, start + BACKUP_CHUNK));
      generation = deps.time();
      if (!submit()) return finish('failed');
      phase = 'writing';
      return 'pending';
    }
    if (phase === 'writing') {
      if (deps.writer.pending() === 0) {
        deps.reader.request(STORES.backup.pages.slice(0, chunks.length));
        phase = 'verifying';
      }
      return 'pending';
    }
    const result = verify();
    if (result === 'pending') {
      // 页载入后请求即视为完成；载入的那个 tick 若 boot 没有调用 backup，页已被删除，这里重新请求。
      // 请求是幂等的：页仍处于激活状态时 segments 不会重复调用 setActiveSegments。
      deps.reader.request(STORES.backup.pages.slice(0, chunks.length));
      return 'pending';
    }
    if (result) return finish('done');
    if (retried || !submit()) return finish('failed');
    retried = true;
    phase = 'writing';
    return 'pending';
  };
};
