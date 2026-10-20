/**
 * 文件摘要：kernel.segments，整页覆盖语义的 segment 存储（设计见 docs/design/kernel/segments.md，架构设计 6.8）。
 *
 * 所属位置：src/kernel/segments/，kernel 内部模块；与 kernel.memory、kernel.intershard 一起构成唯一的持久化入口（架构 4.2），
 * 是唯一访问 RawMemory.segments 与 RawMemory.setActiveSegments 的模块。M1 的使用方都在 kernel 内部：
 * bootPort 的 Memory 备份（backup，页 80–89，可回读）与 stats（页 50，只写）。
 * 每 tick 流程：beginTick 读取上一 tick 激活载入的页并删除这些键 → 使用方 submit/request/read → commit 按优先级写出、
 * 提交激活请求。删除已读键与写出名额计算共同保证 tick 结束时 RawMemory.segments 不超过 10 个键：
 * 违反时 driver 在收尾抛错，整个 tick 的 intent、Memory 与 segment 写入全部丢失（segments.md 第 2 节）。
 * 状态：待写页、激活请求与本 tick 载入的页保存在 createSegments 的闭包中（heap），随 kernel 实例存在，
 * 软重置与 global reset 后清空；整页覆盖语义不依赖上次写入成功，需要确认的使用方自行回读。
 */
import { decodePage, encodePage, type Page, SEG_PAGE_LIMIT } from './page';

export { decodePage, encodePage, SEG_PAGE_LIMIT, type Page, type PageHeader } from './page';

/** 每 tick 写出页数上限，给其他 store 与残留键留余量。 */
export const SEG_WRITES_PER_TICK = 5;
/** 低优先级 store 推迟写回的 bucket 门槛。 */
export const SEG_LOW_BUCKET = 1000;
/** driver 每 tick 可保存的 segment 键数上限，也是同时激活的页数上限。 */
export const SEG_KEY_LIMIT = 10;

/** M1 的 store 名。 */
export type StoreName = 'backup' | 'stats';

/** store 的静态配置：页号分配（6.8）、写回优先级（数值小者先写）与 bucket 低时是否推迟。 */
interface StoreSpec {
  readonly pages: readonly number[];
  readonly priority: number;
  readonly deferOnLowBucket: boolean;
}

/** 页号分配表；backup 挡在不可逆操作前面，不受 bucket 门槛限制。 */
export const STORES: Readonly<Record<StoreName, StoreSpec>> = Object.freeze({
  backup: Object.freeze({ pages: Object.freeze([80, 81, 82, 83, 84, 85, 86, 87, 88, 89]), priority: 0, deferOnLowBucket: false }),
  stats: Object.freeze({ pages: Object.freeze([50]), priority: 1, deferOnLowBucket: true }),
});

/** 平台端口：游戏中转发当前 tick 的 RawMemory，测试中由严格平台模拟提供。 */
export interface SegmentsPlatformPort {
  /**
   * @description 取得当前 tick 的 RawMemory.segments；每次调用重新读取全局，不缓存上一 tick 的对象。
   * @returns 本 tick 的 segment 字典 { [页号]: 页内容 }。
   */
  segments(): Record<string, unknown>;
  /**
   * @description 提交激活请求，下一 tick 生效并保持到再次调用。
   * @param ids 最多 10 个页号。
   * @returns 无返回值。
   * @throws {Error} 平台拒绝请求（数量或页号非法）。
   */
  setActive(ids: readonly number[]): void;
}

/** 创建选项，均由宿主注入。 */
export interface SegmentsOptions {
  readonly platform: SegmentsPlatformPort;
  /**
   * @description 告警输出；回调异常被隔离。
   * @param message 不含页内容的告警正文。
   * @returns 无返回值。
   */
  warn(message: string): void;
  /**
   * @description 当前 bucket，用于推迟低优先级 store 的写回。
   * @returns Game.cpu.bucket。
   */
  bucket(): number;
  /**
   * @description 当前 epoch：取自项目标记，Memory 不可用时为 0。写出页头与回读校验时调用，同 tick 清空后立即生效。
   * @returns 当前 epoch。
   */
  epoch(): number;
}

/** submit 的结果：已排队、页头加正文超过单页上限、页号不属于该 store。 */
export type SubmitResult = 'queued' | 'too-large' | 'not-owned';

/** 某个 store 的写入器。 */
export interface PageWriter {
  /**
   * @description 覆盖该页的待写内容；同一页再次提交时覆盖尚未写出的内容，变脏时间沿用首次。
   * 体积与归属问题以返回值报告并告警，不抛错（6.8 安全规则 4）。
   * @param page 页号，必须属于本 store。
   * @param batch 批次：g 为 generation，i 为批次内序号，n 为批次页数。
   * @param body 原样正文。
   * @returns 排队结果。
   * @throws {TypeError} 批次字段不是非负整数、i 不小于 n 或正文不是字符串（调用错误）。
   */
  submit(page: number, batch: { readonly g: number; readonly i: number; readonly n: number }, body: string): SubmitResult;
  /**
   * @description 统计本 store 尚未写出的页数。
   * @returns 待写页数。
   */
  pending(): number;
}

/** 某个 store 的读取器。 */
export interface PageReader {
  /**
   * @description 登记激活请求；本 tick commit 时提交，下一 tick 可读。页载入后请求即视为完成。
   * @param pages 本 store 的页号；不属于本 store 的页号被忽略。
   * @returns 无返回值。
   */
  request(pages: readonly number[]): void;
  /**
   * @description 读取本 tick 载入的页。
   * @param page 页号。
   * @returns 本 tick 未载入为 pending；页头缺失、无法解析、owner 不符、epoch 不一致或页号不属于本 store 为 empty。
   */
  read(page: number): Page | 'pending' | 'empty';
}

/** kernel 内部接口，由 kernel.lifecycle 每 tick 驱动。 */
export interface SegmentsHost {
  /**
   * @description tick 起点：读取上一 tick 激活载入的页，随后从 RawMemory.segments 删除这些键。
   * @returns 无返回值。
   */
  beginTick(): void;
  /**
   * @description 取得 store 的写入器；每次调用新建轻量对象，共享同一待写队列。
   * @param store store 名。
   * @param version 数据版本，写入页头 v。
   * @returns 只能写本 store 页号的写入器。
   * @throws {TypeError} version 不是非负整数。
   */
  writer(store: StoreName, version: number): PageWriter;
  /**
   * @description 取得 store 的读取器；M1 只有备份校验需要读。
   * @param store store 名。
   * @returns 只能读本 store 页号的读取器。
   */
  reader(store: 'backup'): PageReader;
  /**
   * @description commit 阶段每 tick 一次：按优先级与变脏顺序写出待写页，并提交激活请求。
   * @returns 无返回值。
   * @throws {*} 平台 setActiveSegments 的异常原样传播；待写页已写出部分保持写出。
   */
  commit(): void;
}

/** 待写页：store、页头中由使用方给出的字段、正文与变脏序号（越小越早变脏）。 */
interface PendingPage {
  readonly store: StoreName;
  readonly v: number;
  readonly g: number;
  readonly i: number;
  readonly n: number;
  readonly body: string;
  readonly seq: number;
}

/**
 * @description 判断值是否为非负安全整数。
 * @param value 待判断的值。
 * @returns 是非负安全整数时为 true。
 */
const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * @description 判断页号字符串是否为合法 segment 键（driver 按 parseInt 解析，0–99）。
 * @param key RawMemory.segments 的键。
 * @returns 合法页号；非法时为 undefined。
 */
const pageId = (key: string): number | undefined => {
  const id = Number(key);
  return Number.isInteger(id) && id >= 0 && id <= 99 && String(id) === key ? id : undefined;
};

/**
 * @description 创建 segments 宿主；构造不访问平台。
 * @param options 平台端口、告警、bucket 与 epoch 读取函数。
 * @returns 每 tick 由 kernel 驱动的宿主接口。
 */
export const createSegments = (options: SegmentsOptions): SegmentsHost => {
  const { platform } = options;
  // { [页号]: 待写页 }；同一页只保留最新一份，写出或超限丢弃时移除。
  const pending = new Map<number, PendingPage>();
  // 待提交的激活请求页号，按登记顺序；页在 beginTick 载入后移除。
  const requests = new Set<number>();
  // { [页号]: 本 tick 载入的页内容 }；每个 beginTick 重建，键集合同时是"上一 tick 生效的激活集"的观测结果。
  const loaded = new Map<number, string>();
  // 变脏序号，单调递增；只用于同优先级内的排序，不跨实例。
  let seq = 0;

  /**
   * @description 调用告警端口并隔离其异常。
   * @param message 告警正文。
   * @returns 无返回值。
   */
  const warn = (message: string): void => {
    try { options.warn(message); } catch { /* 告警失败不能改变存储结果。 */ }
  };

  /**
   * @description 判断本 tick 载入的页集合是否与激活请求一致。以实际载入为准：撤销激活的 tick 被驱动丢弃时，
   * 下一 tick 仍观测到旧页，会再次撤销。
   * @param wanted 本 tick 要提交的激活集。
   * @returns 一致时为 true。
   */
  const sameAsLoaded = (wanted: readonly number[]): boolean =>
    wanted.length === loaded.size && wanted.every((id) => loaded.has(id));

  return {
    /**
     * @description 读取并删除上一 tick 激活载入的页，语义见 SegmentsHost.beginTick。
     * @returns 无返回值。
     */
    beginTick() {
      loaded.clear();
      const raw = platform.segments();
      for (const key of Object.keys(raw)) {
        const id = pageId(key);
        const value = raw[key];
        if (id !== undefined && typeof value === 'string') { loaded.set(id, value); requests.delete(id); }
        // 已读或无法识别的键都删除，否则 driver 会在收尾时把它们原样保存并占用 10 个键的名额。
        delete raw[key];
      }
    },
    /**
     * @description 取得 store 的写入器，语义见 SegmentsHost.writer。
     * @param store store 名。
     * @param version 数据版本。
     * @returns 写入器。
     * @throws {TypeError} version 非法。
     */
    writer(store, version) {
      if (!isCount(version)) throw new TypeError('segment 数据版本非法');
      const spec = STORES[store];
      return {
        /**
         * @description 覆盖该页的待写内容，语义见 PageWriter.submit。
         * @param page 页号。
         * @param batch 批次字段。
         * @param body 原样正文。
         * @returns 排队结果。
         * @throws {TypeError} 批次或正文非法。
         */
        submit(page, batch, body) {
          if (!isCount(batch.g) || !isCount(batch.i) || !isCount(batch.n) || batch.i >= batch.n || typeof body !== 'string') {
            throw new TypeError('segment 批次或正文非法');
          }
          if (!spec.pages.includes(page)) { warn(`segment ${page} 不属于 ${store}`); return 'not-owned'; }
          // 以当前 epoch 估算页头长度；写出时再按届时的 epoch 复核一次。
          const size = encodePage({ v: version, o: store, g: batch.g, e: options.epoch(), i: batch.i, n: batch.n }, '').length
            + body.length;
          if (size > SEG_PAGE_LIMIT) { warn(`segment ${page}（${store}）超过单页上限`); return 'too-large'; }
          const previous = pending.get(page);
          pending.set(page, { store, v: version, g: batch.g, i: batch.i, n: batch.n, body, seq: previous?.seq ?? (seq += 1) });
          return 'queued';
        },
        /**
         * @description 统计本 store 尚未写出的页数。
         * @returns 待写页数。
         */
        pending() {
          let count = 0;
          for (const page of pending.values()) if (page.store === store) count += 1;
          return count;
        },
      };
    },
    /**
     * @description 取得 store 的读取器，语义见 SegmentsHost.reader。
     * @param store store 名。
     * @returns 读取器。
     */
    reader(store) {
      const spec = STORES[store];
      return {
        /**
         * @description 登记激活请求，语义见 PageReader.request。
         * @param pages 页号。
         * @returns 无返回值。
         */
        request(pages) {
          for (const page of pages) if (spec.pages.includes(page)) requests.add(page);
        },
        /**
         * @description 读取本 tick 载入的页，语义见 PageReader.read。
         * @param page 页号。
         * @returns 页、pending 或 empty。
         */
        read(page) {
          if (!spec.pages.includes(page)) return 'empty';
          const text = loaded.get(page);
          if (text === undefined) return 'pending';
          const decoded = decodePage(text);
          return decoded && decoded.header.o === store && decoded.header.e === options.epoch() ? decoded : 'empty';
        },
      };
    },
    /**
     * @description 写出待写页并提交激活请求，语义见 SegmentsHost.commit。
     * @returns 无返回值。
     * @throws {*} 平台 setActiveSegments 的异常。
     */
    commit() {
      const raw = platform.segments();
      // 键数不变量：beginTick 已删除载入的键，正常情况下这里为空。残留键来自违反 4.2 的写入或读后删除失败：
      // 非法的键会使 driver 丢弃整个 tick，直接删除；合法的保留并占用名额。
      let residual = 0;
      for (const key of Object.keys(raw)) {
        const id = pageId(key);
        const value = raw[key];
        if (id === undefined || typeof value !== 'string' || value.length > SEG_PAGE_LIMIT) {
          delete raw[key];
          warn(`RawMemory.segments 中的非法键 ${key} 已删除`);
        } else residual += 1;
      }
      if (residual > 0) warn(`RawMemory.segments 残留 ${residual} 个键，本 tick 写出名额相应减少`);
      let slots = Math.max(0, Math.min(SEG_WRITES_PER_TICK, SEG_KEY_LIMIT - residual));
      if (slots > 0 && pending.size > 0) {
        const low = options.bucket() < SEG_LOW_BUCKET;
        // 待写页很少（M1 最多 11 页），排序成本可以忽略；先按 store 优先级，再按变脏先后，避免饿死。
        const order = [...pending].filter(([, page]) => !(low && STORES[page.store].deferOnLowBucket))
          .sort(([, a], [, b]) => STORES[a.store].priority - STORES[b.store].priority || a.seq - b.seq);
        const epoch = options.epoch();
        for (const [id, page] of order) {
          if (slots === 0) break;
          pending.delete(id);
          const text = encodePage({ v: page.v, o: page.store, g: page.g, e: epoch, i: page.i, n: page.n }, page.body);
          // epoch 位数在 submit 之后变长时才可能超限；丢弃该页，不让 driver 丢弃整个 tick。
          if (text.length > SEG_PAGE_LIMIT) { warn(`segment ${id}（${page.store}）超过单页上限，已丢弃`); continue; }
          raw[id] = text;
          slots -= 1;
        }
      }
      const wanted = [...requests].slice(0, SEG_KEY_LIMIT);
      if (!sameAsLoaded(wanted)) platform.setActive(wanted);
    },
  };
};

/**
 * @description 创建绑定游戏全局 RawMemory 的平台端口。按架构 4.2，只有 kernel.segments 可以访问 segment 接口，
 * 所以装配方通过此函数取得端口，自身不触碰 RawMemory。每次调用读取当前 tick 的全局对象。
 * @returns 游戏环境的 segment 平台端口。
 */
export const createGameSegmentsPlatform = (): SegmentsPlatformPort => ({
  /**
   * @description 取得当前 tick 的 RawMemory.segments。
   * @returns segment 字典。
   */
  segments: () => RawMemory.segments as unknown as Record<string, unknown>,
  /**
   * @description 提交激活请求。
   * @param ids 页号。
   * @returns 无返回值。
   */
  setActive: (ids) => RawMemory.setActiveSegments([...ids]),
});
