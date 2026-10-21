/** kernel.segments：页格式、归属与体积、写回调度、键数不变量与激活集管理；以严格平台模拟驱动。 */
import { createSegments, decodePage, encodePage, SEG_PAGE_LIMIT } from '@/kernel/segments';
import { createMemoryPlatform, PlatformError } from '../../platform/memory';

/**
 * @description 创建 segments 测试宿主：严格平台模拟、可调的 bucket 与 epoch、可观测的告警与激活调用。
 * @param segments 平台上已有的页内容。
 * @returns 宿主、平台与 tick 驱动。
 */
const setup = (segments: Record<number, string> = {}) => {
  const target = {} as { RawMemory: RawMemory };
  const platform = createMemoryPlatform({ target, segments });
  const state = { bucket: 10000, epoch: 1 };
  const warn = jest.fn();
  const setActive = jest.fn((ids: readonly number[]) => target.RawMemory.setActiveSegments([...ids]));
  const host = createSegments({
    platform: { segments: () => target.RawMemory.segments as unknown as Record<string, unknown>, setActive },
    warn, bucket: () => state.bucket, epoch: () => state.epoch,
  });
  /**
   * @description 驱动一个 tick：beginTick → run → commit；用户代码异常重新抛出。
   * @param run 本 tick 的测试代码，可取得 RawMemory.segments。
   * @returns 无返回值。
   * @throws {*} 测试代码异常；平台收尾违规时抛 PlatformError。
   */
  const tick = (run: (raw: Record<string, unknown>) => void = () => {}) => {
    const result = platform.tick(() => {
      host.beginTick();
      run(target.RawMemory.segments as unknown as Record<string, unknown>);
      host.commit();
    });
    if (result.error !== undefined) throw result.error;
  };
  return { host, platform, state, warn, setActive, tick };
};

const batch = { g: 5, i: 0, n: 1 };

describe('页格式', () => {
  test('页头一行、换行、原样正文；解析往返', () => {
    const text = encodePage({ v: 1, o: 'backup', g: 5, e: 2, i: 0, n: 1 }, 'a\n"b"');
    expect(text).toBe('{"v":1,"o":"backup","g":5,"e":2,"i":0,"n":1}\na\n"b"');
    expect(decodePage(text)).toEqual({ header: { v: 1, o: 'backup', g: 5, e: 2, i: 0, n: 1 }, body: 'a\n"b"' });
  });

  test('空页、外来格式与非法页头解析为 null', () => {
    for (const text of ['', 'plain', '\nbody', '{oops\nx', '[]\nx', '{"v":1,"o":"b","g":1,"e":1,"i":1,"n":1}\nx',
      '{"v":1,"o":2,"g":1,"e":1,"i":0,"n":1}\nx', '{"v":-1,"o":"b","g":1,"e":1,"i":0,"n":1}\nx']) {
      expect(decodePage(text)).toBeNull();
    }
  });
});

describe('写入', () => {
  test('写出时页头取当前 epoch 与使用方给出的版本', () => {
    const h = setup();
    h.tick(() => {
      expect(h.host.writer('backup', 1).submit(80, batch, 'abc')).toBe('queued');
      h.state.epoch = 3; // 同 tick 清空后 epoch 已变化
    });
    expect(h.platform.segment(80)).toBe('{"v":1,"o":"backup","g":5,"e":3,"i":0,"n":1}\nabc');
    h.tick(() => h.host.writer('stats', 4).submit(50, batch, 's'));
    expect(decodePage(h.platform.segment(50)!)!.header).toMatchObject({ v: 4, o: 'stats' });
  });

  test('页号不属于 store、超过单页上限时不排队并告警，不抛错', () => {
    const h = setup();
    h.tick(() => {
      const stats = h.host.writer('stats', 1);
      const backup = h.host.writer('backup', 1);
      expect(stats.submit(80, batch, 'x')).toBe('not-owned');
      expect(backup.submit(50, batch, 'x')).toBe('not-owned');
      const head = encodePage({ v: 1, o: 'backup', g: 5, e: 1, i: 0, n: 1 }, '').length;
      expect(backup.submit(80, batch, 'x'.repeat(SEG_PAGE_LIMIT - head + 1))).toBe('too-large');
      expect(backup.submit(81, batch, 'x'.repeat(SEG_PAGE_LIMIT - head))).toBe('queued');
      expect(backup.pending()).toBe(1);
      expect(stats.pending()).toBe(0);
    });
    expect(h.warn).toHaveBeenCalledTimes(3);
    expect(h.platform.segment(81)!.length).toBe(SEG_PAGE_LIMIT);
    expect(h.platform.segment(80)).toBeUndefined();
  });

  test('调用错误抛 TypeError', () => {
    const h = setup();
    expect(() => h.host.writer('backup', -1)).toThrow(TypeError);
    expect(() => h.host.writer('backup', 1).submit(80, { g: 1, i: 1, n: 1 }, 'x')).toThrow(TypeError);
  });

  test('每 tick 最多写出 5 页，按变脏先后', () => {
    const h = setup();
    const writer = h.host.writer('backup', 1);
    h.tick(() => {
      for (let i = 9; i >= 0; i -= 1) writer.submit(80 + i, { g: 1, i, n: 10 }, `p${i}`);
    });
    expect([89, 88, 87, 86, 85].every((id) => h.platform.segment(id) !== undefined)).toBe(true);
    expect(h.platform.segment(84)).toBeUndefined();
    expect(writer.pending()).toBe(5);
    h.tick();
    expect(writer.pending()).toBe(0);
    expect(decodePage(h.platform.segment(80)!)!.body).toBe('p0');
  });

  test('backup 优先于 stats；同页再次提交覆盖内容但沿用变脏顺序', () => {
    const h = setup();
    const backup = h.host.writer('backup', 1);
    h.tick(() => {
      h.host.writer('stats', 1).submit(50, batch, 'old');
      for (let i = 0; i < 5; i += 1) backup.submit(80 + i, { g: 1, i, n: 5 }, 'b');
      h.host.writer('stats', 1).submit(50, batch, 'new');
    });
    expect(h.platform.segment(50)).toBeUndefined();
    h.tick();
    expect(decodePage(h.platform.segment(50)!)!.body).toBe('new');
  });

  test('bucket 低时推迟 stats，backup 不受限制', () => {
    const h = setup();
    h.state.bucket = 999;
    h.tick(() => {
      h.host.writer('stats', 1).submit(50, batch, 's');
      h.host.writer('backup', 1).submit(80, batch, 'b');
    });
    expect(h.platform.segment(80)).toBeDefined();
    expect(h.platform.segment(50)).toBeUndefined();
    h.state.bucket = 1000;
    h.tick();
    expect(h.platform.segment(50)).toBeDefined();
  });

  test('残留的合法键占用名额，非法键被删除，平台不丢弃 tick', () => {
    const h = setup();
    const writer = h.host.writer('backup', 1);
    expect(() => h.tick((raw) => {
      for (let i = 0; i < 10; i += 1) writer.submit(80 + i, { g: 1, i, n: 10 }, 'b');
      for (let id = 0; id < 6; id += 1) raw[id] = 'x';
      raw.abc = 'y';
      raw[7] = 5;
    })).not.toThrow();
    expect(writer.pending()).toBe(6);
    expect(h.warn).toHaveBeenCalled();
  });
});

describe('读取与激活', () => {
  test('请求在下一 tick 可读，读后删除键并在下一次提交时退出激活集', () => {
    const page = encodePage({ v: 1, o: 'backup', g: 5, e: 1, i: 0, n: 1 }, 'body');
    const h = setup({ 80: page });
    const reader = h.host.reader('backup');
    h.tick(() => {
      reader.request([80, 50]);
      expect(reader.read(80)).toBe('pending');
    });
    expect(h.setActive).toHaveBeenLastCalledWith([80]);
    h.tick((raw) => {
      expect(Object.keys(raw)).toEqual([]);
      expect(reader.read(80)).toEqual({ header: { v: 1, o: 'backup', g: 5, e: 1, i: 0, n: 1 }, body: 'body' });
    });
    expect(h.setActive).toHaveBeenLastCalledWith([]);
    expect(h.platform.activeSegments).toEqual([]);
    h.tick(() => expect(reader.read(80)).toBe('pending'));
    // 激活集已与请求一致，不再调用。
    expect(h.setActive).toHaveBeenCalledTimes(2);
  });

  test('epoch 或 owner 不符、从未写过与不属于本 store 的页为 empty', () => {
    const h = setup({
      80: encodePage({ v: 1, o: 'backup', g: 5, e: 2, i: 0, n: 1 }, 'x'),
      81: encodePage({ v: 1, o: 'stats', g: 5, e: 1, i: 0, n: 1 }, 'x'),
    });
    const reader = h.host.reader('backup');
    h.tick(() => reader.request([80, 81, 82]));
    h.tick(() => {
      expect(reader.read(80)).toBe('empty');
      expect(reader.read(81)).toBe('empty');
      expect(reader.read(82)).toBe('empty');
      expect(reader.read(50)).toBe('empty');
    });
  });

  test('撤销激活的 tick 被驱动丢弃时，下一 tick 再次撤销', () => {
    const h = setup({ 80: encodePage({ v: 1, o: 'backup', g: 5, e: 1, i: 0, n: 1 }, 'x') });
    h.tick(() => h.host.reader('backup').request([80]));
    // 违反键数上限使整个 tick 失败：撤销请求随之丢失，激活集保持 [80]。
    expect(() => h.tick((raw) => { for (let id = 0; id < 11; id += 1) raw[id] = 'x'; })).toThrow(PlatformError);
    expect(h.platform.activeSegments).toEqual([80]);
    h.tick();
    expect(h.platform.activeSegments).toEqual([]);
  });

  test('请求超过 10 页时分批提交', () => {
    const h = setup();
    const reader = h.host.reader('backup');
    h.tick(() => reader.request([80, 81, 82, 83, 84, 85, 86, 87, 88, 89]));
    expect(h.setActive).toHaveBeenLastCalledWith([80, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
  });
});
