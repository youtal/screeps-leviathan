/**
 * 文件摘要：kernel.bootPort 与 lifecycle 集成的单元测试，以 Memory/segment 严格平台模拟与假 GamePort 驱动整个 kernel。
 * 覆盖：端口只在 boot 钩子期间有效；summary；initialize 与 clearMemory 的前置条件、标记初值与 epoch；
 * 备份的分页（不拆开代理对，审计 S-27）、跨 tick 写出、回读校验、重写与失败；暂停 tick 不 setup、不运行业务阶段、返回 paused；
 * Memory 已就绪时“软重置 → 备份 → 清空”在新实例中完成；boot 抛错时软重置登记作废；clearInterShard；sys 写入。
 */
import type { BootContext, BootDefinition } from '@/contracts/boot';
import type { ModuleDefinition } from '@/contracts/module';
import { BACKUP_CAPACITY, BACKUP_CHUNK } from '@/kernel/bootPort';
import { decodePage } from '@/kernel/segments';
import { READY_MEMORY, kernelHarness, marker } from '../lifecycle/harness';

/**
 * @description 以脚本驱动的 boot：每个 kernel 实例内第 n 次调用 boot 钩子时执行 script(ctx, n)，n 从 1 开始。
 * @param script 每次 boot 调用执行的测试代码。
 * @param contexts 收集每个实例的 BootContext，供在 boot 之外调用端口。
 * @returns boot 定义。
 */
const scripted = (script: (ctx: BootContext, n: number) => void, contexts: BootContext[] = []): BootDefinition => ({
  setup: (ctx) => {
    contexts.push(ctx);
    let n = 0;
    return {
      /**
       * @description 执行本次脚本。
       * @returns 无返回值。
       */
      boot: () => { n += 1; script(ctx, n); },
    };
  },
});

/**
 * @description 记录 setup 与 sense 调用的模块。
 * @param calls 调用记录。
 * @returns 模块定义。
 */
const recorder = (calls: string[]): ModuleDefinition => ({
  id: 'm', tier: 'survival', priority: 0,
  setup: () => { calls.push('setup'); return { sense: () => { calls.push('sense'); } }; },
});

/**
 * @description 读取平台上的备份页并拼接正文。
 * @param h kernel 测试宿主。
 * @returns 备份页拼接的正文与第一页的页头。
 */
const backupOf = (h: ReturnType<typeof kernelHarness>) => {
  const first = decodePage(h.platform.segment(80) ?? '');
  let body = '';
  for (let i = 0; i < (first?.header.n ?? 0); i += 1) body += decodePage(h.platform.segment(80 + i)!)!.body;
  return { header: first?.header, body };
};

test('端口只在 boot 钩子运行期间有效', () => {
  const contexts: BootContext[] = [];
  const h = kernelHarness({ modules: [], boot: scripted((ctx) => { ctx.port.summary(); }, contexts) });
  h.tick();
  expect(() => contexts[0].port.summary()).toThrow('只在 boot 阶段有效');
  expect(() => contexts[0].port.softReset()).toThrow('只在 boot 阶段有效');
});

test('summary 反映本实例加载时的原始文本，不受之后的写入影响', () => {
  const text = JSON.stringify({ creeps: {}, spawns: {} });
  const seen: unknown[] = [];
  const h = kernelHarness({ modules: [], memory: text, boot: scripted((ctx, n) => {
    seen.push(ctx.port.summary());
    if (n === 1) ctx.port.initialize();
  }) });
  h.tick(); h.tick();
  expect(seen[0]).toEqual({ empty: true, parsed: true, rootKeys: ['creeps', 'spawns'], marker: null });
  expect(seen[1]).toBe(seen[0]);
});

test('SR-02：标记合法而命名空间其余结构不合法时，概要给出标记，访问 sys 抛错', () => {
  const texts = [
    JSON.stringify({ leviathan: { sys: marker, part: {}, rooms: {}, creeps: {}, flags: {}, extra: 1 } }),
    JSON.stringify({ leviathan: { sys: marker, part: { m: { a: { data: 1 } } }, rooms: {}, creeps: {}, flags: {} } }),
  ];
  for (const memory of texts) {
    const seen: { parsed?: boolean; marker?: unknown; sysThrows?: boolean } = {};
    const h = kernelHarness({ modules: [], memory, boot: scripted((ctx) => {
      const summary = ctx.port.summary();
      seen.parsed = summary.parsed;
      seen.marker = summary.marker;
      try { ctx.sys.get(['epoch']); seen.sysThrows = false; } catch { seen.sysThrows = true; }
    }) });
    expect(h.tick()).toBe('degraded'); // Memory 加载失败
    expect(seen).toEqual({ parsed: true, marker, sysThrows: true });
  }
});

describe('initialize', () => {
  test('Memory 为 empty 时加入命名空间、保留其他根键，标记由 kernel 生成；同 tick setup 并提交', () => {
    const calls: string[] = [];
    const h = kernelHarness({ modules: [recorder(calls)], memory: JSON.stringify({ foreign: 1 }), boot: scripted((ctx, n) => {
      if (n === 1) {
        ctx.port.initialize();
        ctx.sys.set(['fp', 'creepCount'], 3);
      }
    }) });
    expect(h.tick()).toBe('ok');
    expect(calls).toEqual(['setup', 'sense']);
    const saved = JSON.parse(h.platform.memory);
    expect(Object.keys(saved)).toEqual(['foreign', 'leviathan']);
    expect(saved.leviathan.sys).toEqual({ sig: 'leviathan', schema: 1, shard: 'x', epoch: 1, lastRun: 1,
      release: 'test-release', fp: { rooms: [], spawnIds: [], creepCount: 3 },
      mode: { mode: 'AMBIGUOUS', strength: 'medium', since: 1, evidence: [] } });
  });

  test('Memory 已就绪或加载失败时抛错，boot 失败计为 degraded', () => {
    for (const memory of [READY_MEMORY, '{broken']) {
      const h = kernelHarness({ modules: [], memory, boot: scripted((ctx) => ctx.port.initialize()) });
      expect(h.tick()).toBe('degraded');
      expect(h.lines.some((line) => line.includes('boot 失败'))).toBe(true);
    }
  });

  test('empty 时 sys 不可用', () => {
    const errors: unknown[] = [];
    const h = kernelHarness({ modules: [], memory: '', boot: scripted((ctx) => {
      try { void ctx.sys; } catch (error) { errors.push(error); }
    }) });
    h.tick();
    expect(errors).toHaveLength(1);
  });
});

describe('clearMemory', () => {
  test('普通模块尚未 setup 时清空：丢弃外来键，epoch 为原值 + 1，无可读标记时为 1', () => {
    const h = kernelHarness({ modules: [], memory: JSON.stringify({ foreign: 1 }), boot: scripted((ctx, n) => {
      if (n === 1) ctx.port.clearMemory();
    }) });
    h.tick();
    expect(JSON.parse(h.platform.memory)).toEqual({ leviathan: expect.objectContaining({ sys: expect.objectContaining({ epoch: 1 }) }) });
    const ours = kernelHarness({ modules: [], memory: READY_MEMORY.replace('"epoch":0', '"epoch":6'), boot: scripted((ctx, n) => {
      if (n === 1) ctx.port.clearMemory();
    }) });
    ours.tick();
    expect(JSON.parse(ours.platform.memory).leviathan.sys.epoch).toBe(7);
  });

  test('SB-03：sys 中暂存非法 epoch 时，epoch 仍只增不减', () => {
    const epochOf = (h: ReturnType<typeof kernelHarness>) => JSON.parse(h.platform.memory).leviathan.sys.epoch;
    // 加载时的标记兜底：原 epoch 6。
    const loaded = kernelHarness({ modules: [], memory: READY_MEMORY.replace('"epoch":0', '"epoch":6'), boot: scripted((ctx, n) => {
      if (n === 1) { ctx.sys.set(['epoch'], -1); ctx.port.clearMemory(); }
    }) });
    loaded.tick();
    expect(epochOf(loaded)).toBe(7);
    // 本实例已签发的 epoch 兜底：同 tick 第二次清空。
    const twice = kernelHarness({ modules: [], memory: READY_MEMORY.replace('"epoch":0', '"epoch":6'), boot: scripted((ctx, n) => {
      if (n === 1) { ctx.port.clearMemory(); ctx.sys.set(['epoch'], -1); ctx.port.clearMemory(); }
    }) });
    twice.tick();
    expect(epochOf(twice)).toBe(8);
    // 初始化签发的 epoch 1 同样计入。
    const fresh = kernelHarness({ modules: [], memory: '', boot: scripted((ctx, n) => {
      if (n === 1) { ctx.port.initialize(); ctx.sys.set(['epoch'], -1); ctx.port.clearMemory(); }
    }) });
    fresh.tick();
    expect(epochOf(fresh)).toBe(2);
  });

  test('普通模块已 setup 后抛错，要求先软重置', () => {
    const errors: string[] = [];
    const h = kernelHarness({ modules: [recorder([])], boot: scripted((ctx, n) => {
      if (n === 2) { try { ctx.port.clearMemory(); } catch (error) { errors.push(String(error)); } }
    }) });
    h.tick(); h.tick();
    expect(errors[0]).toContain('须先软重置');
  });

  test('解除加载失败：损坏文本清空后本 tick 即可 setup', () => {
    const calls: string[] = [];
    const h = kernelHarness({ modules: [recorder(calls)], memory: '{broken', boot: scripted((ctx, n) => {
      if (n === 1) ctx.port.clearMemory();
    }) });
    expect(h.tick()).toBe('ok');
    expect(calls).toEqual(['setup', 'sense']);
    expect(Object.keys(JSON.parse(h.platform.memory))).toEqual(['leviathan']);
  });
});

describe('backup', () => {
  test('备份进行中为暂停 tick；回读一致后完成，同 tick 可清空并 setup', () => {
    const calls: string[] = [];
    const states: string[] = [];
    const text = '{broken';
    const h = kernelHarness({ modules: [recorder(calls)], memory: text, boot: scripted((ctx) => {
      const state = ctx.port.backup();
      states.push(state);
      if (state === 'done' && states.length === 3) ctx.port.clearMemory();
    }) });
    // Memory 加载失败本应计为 degraded；暂停 tick 不计，保底循环不会在备份期间接管。
    expect([h.tick(), h.tick(), h.tick()]).toEqual(['paused', 'paused', 'ok']);
    expect(states).toEqual(['pending', 'pending', 'done']);
    expect(calls).toEqual(['setup', 'sense']);
    expect(backupOf(h)).toEqual({ header: { v: 1, o: 'backup', g: 1, e: 0, i: 0, n: 1 }, body: text });
    h.tick();
    expect(states[3]).toBe('done');
  });

  test('多页备份跨 tick 写出（每 tick 最多 5 页），全部写出后才请求回读', () => {
    const text = JSON.stringify({ foreign: 'x'.repeat(BACKUP_CHUNK * 6) });
    const states: string[] = [];
    const h = kernelHarness({ modules: [], memory: text, boot: scripted((ctx) => { states.push(ctx.port.backup()); }) });
    for (let i = 0; i < 3; i += 1) h.tick();
    expect(h.platform.activeSegments).toEqual([80, 81, 82, 83, 84, 85, 86]);
    h.tick();
    expect(states).toEqual(['pending', 'pending', 'pending', 'done']);
    const result = backupOf(h);
    expect(result.header).toMatchObject({ n: 7, g: 1 });
    expect(result.body).toBe(text);
    // 读到页的那个 tick 提交时即撤销激活，之后不再每 tick 载入。
    expect(h.platform.activeSegments).toEqual([]);
  });

  test('Memory 已就绪时备份页的 epoch 取当前标记', () => {
    const h = kernelHarness({ modules: [], memory: READY_MEMORY.replace('"epoch":0', '"epoch":4'),
      boot: scripted((ctx) => { ctx.port.backup(); }) });
    h.tick();
    expect(backupOf(h).header?.e).toBe(4);
  });

  test('SR-03：sys 被隔离期间，备份页头的 epoch 仍为已持久化的值', () => {
    const states: string[] = [];
    const h = kernelHarness({ modules: [], memory: READY_MEMORY.replace('"epoch":0', '"epoch":6'),
      boot: scripted((ctx) => { ctx.sys.set(['epoch'], -1); states.push(ctx.port.backup()); }) });
    for (let i = 0; i < 3; i += 1) h.tick();
    expect(states).toEqual(['pending', 'pending', 'done']);
    expect(backupOf(h).header?.e).toBe(6);
    expect(JSON.parse(h.platform.memory).leviathan.sys.epoch).toBe(6);
  });

  test('审计 S-27：切分点落在代理对上时，代理对留在下一页，每页都不含孤立代理，拼回与原文相等', () => {
    // 第 BACKUP_CHUNK 个码元（下标 BACKUP_CHUNK - 1）恰为 😀 的高位代理。
    const text = `{"x":"${'a'.repeat(BACKUP_CHUNK - 7)}😀b"}`;
    expect(text.charCodeAt(BACKUP_CHUNK - 1)).toBe(0xd83d);
    const states: string[] = [];
    const h = kernelHarness({ modules: [], memory: text, boot: scripted((ctx) => { states.push(ctx.port.backup()); }) });
    for (let i = 0; i < 3; i += 1) h.tick();
    expect(states).toEqual(['pending', 'pending', 'done']);
    const first = decodePage(h.platform.segment(80)!)!.body;
    const second = decodePage(h.platform.segment(81)!)!.body;
    expect([first.length, second.startsWith('😀')]).toEqual([BACKUP_CHUNK - 1, true]);
    expect(backupOf(h).body).toBe(text);
  });

  test('审计 S-27：少取码元使实际页数超出备份区时为 failed', () => {
    // 长度恰为容量，第一个切分点落在代理对上：第一页少取一个码元，余下的需要 10 页，共 11 页。
    const text = `${'a'.repeat(BACKUP_CHUNK - 1)}😀${'a'.repeat(BACKUP_CAPACITY - BACKUP_CHUNK - 1)}`;
    expect(text.length).toBe(BACKUP_CAPACITY);
    const states: string[] = [];
    const h = kernelHarness({ modules: [], memory: text, boot: scripted((ctx) => { states.push(ctx.port.backup()); }) });
    expect(h.tick()).toBe('degraded');
    expect(states).toEqual(['failed']);
  });

  test('空文本无需备份；超过备份区容量为 failed，均不暂停', () => {
    const states: string[] = [];
    const empty = kernelHarness({ modules: [], memory: '', boot: scripted((ctx) => { states.push(ctx.port.backup()); }) });
    expect(empty.tick()).toBe('ok');
    const big = kernelHarness({ modules: [], memory: JSON.stringify({ x: 'y'.repeat(BACKUP_CAPACITY) }),
      boot: scripted((ctx) => { states.push(ctx.port.backup()); }) });
    expect(big.tick()).toBe('ok');
    expect(states).toEqual(['done', 'failed']);
  });

  test('回读不一致时整批重写一次，再不一致为 failed', () => {
    const states: string[] = [];
    let corrupt = 0;
    const h = kernelHarness({ modules: [], memory: '{broken', boot: scripted((ctx) => {
      states.push(ctx.port.backup());
      // 在请求回读的 tick 篡改备份页：segments 把合法的残留键计入名额，driver 照常保存。
      if (corrupt > 0 && states.at(-1) === 'pending' && states.length % 2 === 0) {
        (h.target.RawMemory.segments as unknown as Record<string, string>)[80] = 'garbage';
        corrupt -= 1;
      }
    }) });
    corrupt = 1;
    for (let i = 0; i < 5; i += 1) h.tick();
    expect(states).toEqual(['pending', 'pending', 'pending', 'pending', 'done']);
    const states2: string[] = [];
    const h2 = kernelHarness({ modules: [], memory: '{broken', boot: scripted((ctx) => {
      states2.push(ctx.port.backup());
      if (states2.at(-1) === 'pending' && states2.length % 2 === 0) {
        (h2.target.RawMemory.segments as unknown as Record<string, string>)[80] = 'garbage';
      }
    }) });
    for (let i = 0; i < 5; i += 1) h2.tick();
    expect(states2).toEqual(['pending', 'pending', 'pending', 'pending', 'failed']);
    expect(h2.tick()).toBe('degraded');
  });

  test('boot 抛错优先计为 degraded', () => {
    const h = kernelHarness({ modules: [], memory: '{broken', boot: scripted((ctx) => {
      ctx.port.backup();
      throw new Error('判定失败');
    }) });
    expect(h.tick()).toBe('degraded');
  });
});

test('Memory 已就绪：软重置 → 新实例备份 → 清空，期间业务阶段暂停', () => {
  const calls: string[] = [];
  const healths: unknown[] = [];
  const h = kernelHarness({ modules: [recorder(calls)], boot: scripted((ctx, n) => {
    // 第一个实例：第 2 次 boot 判定出开局，但模块已 setup，只能先软重置。
    if (ctx.port.summary().marker?.epoch === 0 && h.kernel === first) { if (n === 2) ctx.port.softReset(); return; }
    if (ctx.port.backup() === 'done') ctx.port.clearMemory();
  }) });
  const first = h.kernel;
  healths.push(h.tick(), h.tick());
  expect(h.kernel.resetRequested()).toBe(true);
  expect(calls).toEqual(['setup', 'sense']); // 软重置的 tick 不运行业务阶段
  // 第一个实例提交后的文本：setup 时 kernel 申请了启停标志分区（part.kernel.switches），与初始文本不同。
  const committed = h.platform.memory;
  h.rebuild();
  healths.push(h.tick(), h.tick(), h.tick());
  expect(healths).toEqual(['ok', 'paused', 'paused', 'paused', 'ok']);
  expect(calls).toEqual(['setup', 'sense', 'setup', 'sense']);
  expect(JSON.parse(h.platform.memory).leviathan.sys.epoch).toBe(1);
  // 新实例备份的是第一个实例提交后的文本。
  expect(backupOf(h).body).toBe(committed);
  expect(JSON.parse(committed).leviathan.part).toEqual({ kernel: { switches: { version: 1, data: {} } } });
});

test('SR-01：boot 登记软重置后抛错，本 tick 的登记作废；之后正常登记仍生效', () => {
  const h = kernelHarness({ modules: [], boot: scripted((ctx, n) => {
    ctx.port.softReset();
    if (n <= 2) throw new Error('判定失败');
  }) });
  expect(h.tick()).toBe('degraded');
  expect(h.kernel.resetRequested()).toBe(false);
  expect(h.tick()).toBe('degraded');
  expect(h.kernel.resetRequested()).toBe(false);
  expect(h.tick()).toBe('paused');
  expect(h.kernel.resetRequested()).toBe(true);
});

test('clearInterShard：可用时清空本 shard，不可用时什么也不做', () => {
  const ism = { setLocal: jest.fn() };
  const h = kernelHarness({ modules: [], interShard: { InterShardMemory: ism }, boot: scripted((ctx) => ctx.port.clearInterShard()) });
  h.tick();
  expect(ism.setLocal).toHaveBeenCalledWith('');
  const none = kernelHarness({ modules: [], boot: scripted((ctx) => ctx.port.clearInterShard()) });
  expect(none.tick()).toBe('ok');
});

test('sys 写入在提交时持久化，非法标记被隔离', () => {
  const h = kernelHarness({ modules: [], boot: scripted((ctx, n) => {
    if (n === 1) ctx.sys.set(['lastRun'], 9);
    if (n === 2) ctx.sys.set(['schema'], 2);
  }) });
  h.tick();
  expect(JSON.parse(h.platform.memory).leviathan.sys).toEqual({ ...marker, lastRun: 9 });
  h.tick();
  expect(JSON.parse(h.platform.memory).leviathan.sys.schema).toBe(1);
});
