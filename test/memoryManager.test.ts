/**
 * 文件摘要：验证 MemoryManager 的申请协议、分配窗口、双后端提交与可恢复迁移。
 *
 * 覆盖模块：`src/core/memoryManager`（createMemoryManager）与其契约
 * `src/contracts/memory.ts`。覆盖边界：
 * 1. 申请语义——重复声明复用、冲突/非法配置抛错、ready 后读写与强制提交；
 * 2. 提交策略——critical 当 tick 写、checkpoint 按首次 dirty 起算、clean tick 不写；
 * 3. 启动窗口——priority 排名只取固定页数、落选者留 Raw、deferStartupWindow 延后封存；
 * 4. Segment 后端——目标页未激活时 pending、写入后回读校验再切换目录、跨 global 恢复；
 * 5. 迁移恢复——journal 在 global reset 之后继续推进且数据不丢；
 * 6. 数据安全——未知 schema 拒绝覆盖、旧 leviathan 一次性导入且不改写、外部根字段保留；
 * 7. 失败语义——写入失败保留 dirty 与诊断、pending 只影响本分区。
 *
 * 替代实现：假平台模拟 RawMemory 的整串读写与 Segment 的"请求激活后下一 tick 可见"，
 * 因此不需要 Screeps 全局对象；用例通过手动推进 tick 精确控制可见性与到期时机。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不读写真实游戏存储。
 */
import { createMemoryManager } from '@/core/memoryManager';
import { createLogging } from '@/core/logger';
import type { MemoryAccessor, DeepReadonly } from '@/contracts/memory';
import type { LogOptions, LoggerFactory } from '@/contracts/logging';
import type { MemoryPlatform } from '@/core/memoryManager/types';

/** 假平台：raw 整串 + 持久化的 Segment 内容 + 一 tick 延迟的可见性。 */
const createPlatform = () => {
  let raw = '{}';
  const content: Record<number, string> = {};
  let visible: number[] = [];
  let requested: number[] = [];
  let failWrite: Error | null = null;
  const platform: MemoryPlatform = {
    readRaw: () => raw,
    writeRaw: (value) => {
      if (failWrite) {
        const error = failWrite;
        failWrite = null;
        throw error;
      }
      raw = value;
    },
    readSegments: () =>
      Object.fromEntries(visible.map((id) => [id, content[id] ?? ''])),
    writeSegment: (id, value) => {
      content[id] = value;
    },
    activeSegments: () => [...visible],
    activateSegments: (ids) => {
      requested = [...ids];
    },
  };
  return {
    platform,
    raw: () => raw,
    setRaw: (value: string) => {
      raw = value;
    },
    content: () => content,
    failNextWrite: (error: Error) => {
      failWrite = error;
    },
    /** 结束当前 tick：本 tick 请求激活的页在下一 tick 可见。 */
    nextTick: () => {
      visible = [...requested];
    },
    /** 立即清空可见集合，复现"已分配页在本 tick 不可见"的窗口。 */
    hideSegments: () => {
      requested = [];
      visible = [];
    },
  };
};

/** 组合管理器与 tick 推进；run 回调相当于"插件阶段"，在其中申请与读写。 */
const createHarness = (
  options: {
    segmentIds?: readonly number[];
    getHostMemory?: () => Record<string, unknown> | undefined;
    maxStartupDeferrals?: number;
    maxObservationTicks?: number;
    logging?: LoggerFactory;
  } = {}
) => {
  const plat = createPlatform();
  const manager = createMemoryManager({
    platform: plat.platform,
    segmentIds: options.segmentIds,
    getHostMemory: options.getHostMemory,
    maxStartupDeferrals: options.maxStartupDeferrals,
    maxObservationTicks: options.maxObservationTicks,
    logging: options.logging,
  });
  let tick = 1;
  return {
    plat,
    manager,
    tick: () => tick,
    run: (fn?: (tick: number) => void) => {
      manager.begin(tick);
      fn?.(tick);
      manager.end(tick);
      plat.nextTick();
      tick++;
    },
    /** 推进到启动窗口封存且所有搬迁结束；用于 Segment 相关断言。 */
    settle: (max = 12) => {
      for (let i = 0; i < max; i++) {
        manager.begin(tick);
        manager.end(tick);
        plat.nextTick();
        tick++;
        const status = manager.getStatus();
        if (!status.startupWindowOpen && status.migration === null) return;
      }
      throw new Error('migration did not settle');
    },
  };
};

/** 读取主 Memory 里的 MemoryManager 命名空间。 */
const namespaceOf = (raw: string) => JSON.parse(raw).memoryManager;

/** 断言 access 处于 ready 并返回其数据视图。 */
const readyData = <M extends object>(accessor: MemoryAccessor<M>): M => {
  const access = accessor.access();
  expect(access.status).toBe('ready');
  if (access.status !== 'ready') throw new Error('unreachable');
  return access.query() as M;
};

/** 共享平台的多 global 时间线：run/settle 手动推进 tick，便于模拟 global reset。 */
const sessions = () => {
  const plat = createPlatform();
  let tick = 1;
  const run = (
    manager: ReturnType<typeof createMemoryManager>,
    fn?: () => void
  ) => {
    manager.begin(tick);
    fn?.();
    manager.end(tick);
    plat.nextTick();
    tick++;
  };
  const settle = (
    manager: ReturnType<typeof createMemoryManager>,
    max = 16
  ) => {
    for (let i = 0; i < max; i++) {
      run(manager);
      const status = manager.getStatus();
      if (
        !status.startupWindowOpen &&
        status.migration === null &&
        status.allocations.every((allocation) => allocation.pending === null)
      )
        return;
    }
    throw new Error('memory manager did not settle');
  };
  return { plat, run, settle };
};

/** 收集日志文本的工厂；levels 缺省时只开 warn/error/report（与项目默认一致）。 */
const collecting = (levels?: LogOptions) => {
  const lines: string[] = [];
  const logging = createLogging({
    levels,
    output: { write: (line) => lines.push(line), notify: () => {} },
  });
  return {
    logging,
    lines,
    text: () => lines.map((line) => line.replace(/<[^>]+>/g, '')).join('\n'),
  };
};

describe('MemoryManager', () => {
  it('commits a new critical partition and skips clean ticks', () => {
    const h = createHarness();
    let accessor!: MemoryAccessor<{ count: number }>;

    h.run(() => {
      accessor = h.manager.bind('alpha')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ count: 0 }),
      });
      const access = accessor.access();
      if (access.status === 'ready')
        access.commit((memory) => (memory.count = 5));
    });

    const stored = namespaceOf(h.plat.raw()).rawPartitions.alpha.main;
    expect(stored).toEqual({ dataVersion: 1, payload: { count: 5 } });

    // 没有变化时整串保持原样，说明 clean tick 不产生写入。
    const before = h.plat.raw();
    h.run();
    expect(h.plat.raw()).toBe(before);
  });

  it('delays checkpoint partitions until the interval elapses', () => {
    const h = createHarness();
    let accessor!: MemoryAccessor<{ n: number }>;
    h.run(() => {
      accessor = h.manager.bind('beta')('main', {
        version: 1,
        layer: 'checkpoint',
        checkpointInterval: 5,
        initialize: () => ({ n: 0 }),
      });
    });

    // 初始化带强制提交，首次写入发生在第 1 tick 结束。
    expect(namespaceOf(h.plat.raw()).rawPartitions.beta.main.payload).toEqual({
      n: 0,
    });

    h.run(() => {
      const access = accessor.access();
      if (access.status === 'ready') access.commit((memory) => (memory.n = 1));
    });
    // dirtySince = 2，interval 5 → 到 tick 6 才到期。
    h.run();
    h.run();
    h.run();
    expect(namespaceOf(h.plat.raw()).rawPartitions.beta.main.payload).toEqual({
      n: 0,
    });
    h.run();
    expect(namespaceOf(h.plat.raw()).rawPartitions.beta.main.payload).toEqual({
      n: 1,
    });
  });

  it('reuses identical applications and rejects conflicts or invalid options', () => {
    const h = createHarness();
    const initialize = () => ({ n: 0 });
    h.run(() => {
      const apply = h.manager.bind('gamma');
      const first = apply('main', {
        version: 1,
        layer: 'critical',
        initialize,
      });
      const second = apply('main', {
        version: 1,
        layer: 'critical',
        initialize,
      });
      expect(second).toBe(first);

      expect(() =>
        apply('main', { version: 2, layer: 'critical', initialize })
      ).toThrow(/conflicting declaration/);
      expect(() =>
        apply('bad id', { version: 1, layer: 'critical', initialize })
      ).toThrow(/invalid localId/);
      expect(() =>
        apply('v0', { version: 0, layer: 'critical', initialize })
      ).toThrow(/positive integer/);
      expect(() =>
        apply('i0', {
          version: 1,
          layer: 'checkpoint',
          checkpointInterval: 0,
          initialize,
        })
      ).toThrow(/positive integer/);
      expect(() =>
        apply('ic', {
          version: 1,
          layer: 'critical',
          checkpointInterval: 3,
          initialize,
        })
      ).toThrow(/only valid for checkpoint/);
      expect(() =>
        apply('pf', {
          version: 1,
          layer: 'critical',
          priority: Infinity,
          initialize,
        })
      ).toThrow(/finite/);
    });
  });

  it('allocates fixed segments by priority and keeps losers on raw memory', () => {
    const h = createHarness({ segmentIds: [0, 1] });
    let low!: MemoryAccessor<{ n: number }>;
    h.run(() => {
      h.manager.bind('p20')('main', {
        version: 1,
        layer: 'critical',
        priority: 20,
        initialize: () => ({ n: 20 }),
      });
      h.manager.bind('p10')('main', {
        version: 1,
        layer: 'critical',
        priority: 10,
        initialize: () => ({ n: 10 }),
      });
      low = h.manager.bind('p5')('main', {
        version: 1,
        layer: 'critical',
        priority: 5,
        initialize: () => ({ n: 5 }),
      });
    });

    // 窗口封存后进入迁移：写目标页 → 下一 tick 回读校验 → 再切换目录。
    h.settle();

    const namespace = namespaceOf(h.plat.raw());
    expect(namespace.allocations.p20.main.backend).toBe('segment');
    expect(namespace.allocations.p10.main.backend).toBe('segment');
    expect(namespace.allocations.p20.main.segmentId).not.toBe(
      namespace.allocations.p10.main.segmentId
    );
    expect(namespace.allocations.p5.main).toEqual({
      backend: 'raw',
      generation: 0,
    });
    // 落选者仍可正常读写，不做惩罚。
    expect(readyData(low)).toEqual({ n: 5 });
    // 搬入 Segment 的分区不再占用 Raw 分区表。
    expect(namespace.rawPartitions.p20).toBeUndefined();
  });

  it('restores segment data across a new manager instance', () => {
    const plat = createPlatform();
    let tick = 1;
    let accessor!: MemoryAccessor<{ n: number }>;
    const first = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0, 1],
    });

    const runWith = (
      manager: ReturnType<typeof createMemoryManager>,
      fn?: () => void
    ) => {
      manager.begin(tick);
      fn?.();
      manager.end(tick);
      plat.nextTick();
      tick++;
    };

    runWith(first, () => {
      accessor = first.bind('delta')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 0 }),
      });
      const access = accessor.access();
      if (access.status === 'ready') access.commit((memory) => (memory.n = 42));
    });
    for (let i = 0; i < 6; i++) runWith(first);
    expect(namespaceOf(plat.raw()).allocations.delta.main.backend).toBe(
      'segment'
    );
    expect(plat.content()[0]).toContain('"n":42');

    // 新实例（模拟 global reset）从 Segment 恢复，而不是重新初始化。
    const second = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0, 1],
    });
    let restored!: MemoryAccessor<{ n: number }>;
    runWith(second, () => {
      restored = second.bind('delta')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: -1 }),
      });
      // 页已激活并可见时应当直接 ready。
      expect(restored.access().status).toBe('ready');
    });
    expect(readyData(restored)).toEqual({ n: 42 });
  });

  it('resumes an interrupted migration after a global reset', () => {
    const plat = createPlatform();
    let tick = 1;
    const first = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    const runWith = (
      manager: ReturnType<typeof createMemoryManager>,
      fn?: () => void
    ) => {
      manager.begin(tick);
      fn?.();
      manager.end(tick);
      plat.nextTick();
      tick++;
    };

    let accessor!: MemoryAccessor<{ n: number }>;
    runWith(first, () => {
      accessor = first.bind('epsilon')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 7 }),
      });
    });
    // 观察页需要一 tick，规划搬迁再一 tick；第三次 end 完成 copy 后 journal 停在 verify。
    runWith(first);
    runWith(first);
    const interrupted = namespaceOf(plat.raw());
    expect(interrupted.allocations.epsilon.main.backend).toBe('raw');
    expect(interrupted.migration).not.toBeNull();
    expect(interrupted.migration.phase).toBe('verify');

    // global reset：新实例继续推进同一个 journal。
    const second = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    let restored!: MemoryAccessor<{ n: number }>;
    runWith(second, () => {
      restored = second.bind('epsilon')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: -1 }),
      });
    });
    // verify → switch → cleanup 各一步：cleanup 确认目录落盘后才清空旧页。
    runWith(second);
    runWith(second);

    expect(readyData(restored)).toEqual({ n: 7 });
    expect(namespaceOf(plat.raw()).allocations.epsilon.main.backend).toBe(
      'segment'
    );
    expect(namespaceOf(plat.raw()).migration).toBeNull();
  });

  it('keeps the startup window open when the framework defers it', () => {
    const h = createHarness({ segmentIds: [0] });
    h.run(() => {
      h.manager.bind('late')('main', {
        version: 1,
        layer: 'critical',
        priority: 100,
        initialize: () => ({ n: 0 }),
      });
      h.manager.deferStartupWindow();
    });
    expect(h.manager.getStatus().startupWindowOpen).toBe(true);

    h.run();
    expect(h.manager.getStatus().startupWindowOpen).toBe(false);
  });

  it('refuses to overwrite an unknown namespace schema', () => {
    const h = createHarness();
    h.plat.setRaw(
      JSON.stringify({
        memoryManager: {
          schemaVersion: 99,
          allocations: {},
          rawPartitions: {},
        },
      })
    );
    let accessor!: MemoryAccessor<{ n: number }>;
    h.run(() => {
      accessor = h.manager.bind('zeta')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 1 }),
      });
    });

    expect(h.manager.getStatus().fault).toMatch(
      /Unsupported MemoryManager schema/
    );
    expect(accessor.access().status).toBe('pending');
    // 拒绝写入：原始文本保持不变。
    expect(namespaceOf(h.plat.raw()).schemaVersion).toBe(99);
  });

  it('imports the legacy leviathan layout once and preserves both namespaces', () => {
    const h = createHarness();
    h.plat.setRaw(
      JSON.stringify({
        leviathan: {
          schemaVersion: 1,
          framework: {
            pluginVersions: { old: 1 },
            pluginHealth: {},
            intentReceipts: [],
            profiler: {},
          },
          plugins: { old: { count: 7 } },
        },
        otherTool: { keep: true },
      })
    );

    let accessor!: MemoryAccessor<{ count: number }>;
    h.run(() => {
      accessor = h.manager.bind('old')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ count: 0 }),
      });
      expect(readyData(accessor)).toEqual({ count: 7 });
      const access = accessor.access();
      if (access.status === 'ready')
        access.commit((memory) => (memory.count = 8));
    });

    const root = JSON.parse(h.plat.raw());
    expect(root.leviathan.plugins.old).toEqual({ count: 7 });
    expect(root.otherTool).toEqual({ keep: true });
    expect(root.memoryManager.rawPartitions.old.main.payload).toEqual({
      count: 8,
    });
  });

  it('merges root fields written by other code in the same global', () => {
    const host: Record<string, unknown> = { other: { a: 1 } };
    const h = createHarness({ getHostMemory: () => host });
    h.plat.setRaw(JSON.stringify({ other: { a: 1 } }));

    const initialize = () => ({ n: 0 });
    h.run(() => {
      h.manager.bind('eta')('main', {
        version: 1,
        layer: 'critical',
        initialize,
      });
    });

    // 其他代码在本 global 内替换/新增根字段：写回时必须合并而不是覆盖。
    host.other = { a: 2 };
    host.added = { b: 1 };
    h.run(() => {
      const accessor = h.manager.bind('eta')('main', {
        version: 1,
        layer: 'critical',
        initialize,
      });
      const access = accessor.access();
      if (access.status === 'ready') access.commit((memory) => (memory.n = 1));
    });

    const root = JSON.parse(h.plat.raw());
    expect(root.other).toEqual({ a: 2 });
    expect(root.added).toEqual({ b: 1 });
  });

  it('keeps partitions dirty when the raw write fails', () => {
    const h = createHarness();
    let accessor!: MemoryAccessor<{ n: number }>;
    h.run(() => {
      accessor = h.manager.bind('theta')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });
    const before = h.plat.raw();

    h.plat.failNextWrite(new Error('memory quota'));
    h.run(() => {
      const access = accessor.access();
      if (access.status === 'ready') access.commit((memory) => (memory.n = 3));
    });

    expect(h.plat.raw()).toBe(before);
    const status = h.manager.getStatus();
    expect(status.allocations[0].dirty).toBe(true);
    expect(status.allocations[0].writeError).toMatch(/memory quota/);

    // 下一 tick 重试成功并清掉 dirty。
    h.run();
    expect(namespaceOf(h.plat.raw()).rawPartitions.theta.main.payload).toEqual({
      n: 3,
    });
    expect(h.manager.getStatus().allocations[0].dirty).toBe(false);
  });

  it('upgrades data versions through migrate and rejects downgrades', () => {
    const plat = createPlatform();
    let tick = 1;
    const first = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    const runWith = (
      manager: ReturnType<typeof createMemoryManager>,
      fn?: () => void
    ) => {
      manager.begin(tick);
      fn?.();
      manager.end(tick);
      plat.nextTick();
      tick++;
    };

    runWith(first, () => {
      const accessor = first.bind('iota')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ count: 1 }),
      });
      const access = accessor.access();
      if (access.status === 'ready')
        access.commit((memory) => (memory.count = 2));
    });

    // 版本 2：提供 migrate，把旧数据搬运到新形状。
    const second = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    let upgraded!: MemoryAccessor<{ total: number }>;
    runWith(second, () => {
      upgraded = second.bind('iota')('main', {
        version: 2,
        layer: 'critical',
        initialize: () => ({ total: 0 }),
        migrate: (memory) => ({
          total: (memory as { count: number }).count + 10,
        }),
      });
    });
    expect(readyData(upgraded)).toEqual({ total: 12 });
    expect(namespaceOf(plat.raw()).rawPartitions.iota.main.dataVersion).toBe(2);

    // 版本 3：缺少 migrate 时拒绝，并给出诊断。
    const third = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    let blocked!: MemoryAccessor<{ total: number }>;
    runWith(third, () => {
      blocked = third.bind('iota')('main', {
        version: 3,
        layer: 'critical',
        initialize: () => ({ total: 0 }),
      });
      expect(blocked.access().status).toBe('pending');
    });
    expect(third.getStatus().allocations[0].writeError).toMatch(
      /missing migrate/
    );
  });

  it('rejects oversized segment payloads and keeps the old data', () => {
    const h = createHarness({ segmentIds: [0] });
    let accessor!: MemoryAccessor<{ blob: string }>;
    h.run(() => {
      accessor = h.manager.bind('big')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ blob: '' }),
      });
    });
    h.settle();
    expect(namespaceOf(h.plat.raw()).allocations.big.main.backend).toBe(
      'segment'
    );
    const before = h.plat.content()[0];

    // 超过单页容量：拒绝写入、保留旧信封，并把 dirty 留给后续重试或缩容。
    h.run(() => {
      const access = accessor.access();
      if (access.status === 'ready')
        access.commit((memory) => (memory.blob = 'x'.repeat(100_001)));
    });

    const status = h.manager.getStatus();
    expect(status.allocations[0].writeError).toMatch(/exceeds capacity/);
    expect(status.allocations[0].dirty).toBe(true);
    expect(h.plat.content()[0]).toBe(before);
  });

  it('keeps pending limited to the affected partition', () => {
    const plat = createPlatform();
    let tick = 1;
    const runWith = (
      manager: ReturnType<typeof createMemoryManager>,
      fn?: () => void
    ) => {
      manager.begin(tick);
      fn?.();
      manager.end(tick);
      plat.nextTick();
      tick++;
    };

    const first = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    runWith(first, () => {
      first.bind('seg')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 1 }),
      });
      first.bind('plain')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 2 }),
      });
    });
    for (let i = 0; i < 6; i++) runWith(first);
    expect(namespaceOf(plat.raw()).allocations.seg.main.backend).toBe(
      'segment'
    );

    // 新 global 启动瞬间：页不可见，segment 分区 pending，raw 分区照常可用。
    const second = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    plat.platform.activateSegments([]);
    plat.nextTick();
    second.begin(tick);
    const segment = second.bind('seg')('main', {
      version: 1,
      layer: 'critical',
      priority: 1,
      initialize: () => ({ n: -1 }),
    });
    const plain = second.bind('plain')('main', {
      version: 1,
      layer: 'critical',
      initialize: () => ({ n: -1 }),
    });
    expect(segment.access().status).toBe('pending');
    expect(readyData(plain)).toEqual({ n: 2 });
    second.end(tick);
    plat.nextTick();
    tick++;

    // 下一 tick 页可见后，begin 会自动重试恢复，无需重新申请。
    second.begin(tick);
    expect(segment.access().status).toBe('ready');
    expect(readyData(segment)).toEqual({ n: 1 });
    second.end(tick);
  });
});

/**
 * 评审修复回归：页所有权、ready 句柄时效、安静 tick、代际单调、无模块恢复、
 * 窗口强制封存与精确激活集合。
 */
describe('MemoryManager review fixes', () => {
  it('never writes a segment page that holds foreign data', () => {
    const h = createHarness({ segmentIds: [0, 1] });
    h.plat.setRaw('{}');
    h.plat.platform.writeSegment(1, '{"tool":"other"}');

    h.run(() => {
      h.manager.bind('p1')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 1 }),
      });
    });
    h.settle();

    const namespace = namespaceOf(h.plat.raw());
    expect(namespace.allocations.p1.main.segmentId).toBe(0);
    expect(h.plat.content()[1]).toBe('{"tool":"other"}');
    expect(h.manager.getStatus().reservedSegments).toEqual([
      { segmentId: 1, reason: 'foreign content' },
    ]);
  });

  it('reserves an unclaimed envelope instead of overwriting it', () => {
    const h = createHarness({ segmentIds: [0, 1] });
    const orphan = JSON.stringify({
      schemaVersion: 1,
      owner: { pluginId: 'ghost', localId: 'main' },
      generation: 7,
      dataVersion: 1,
      payload: { n: 9 },
    });
    h.plat.platform.writeSegment(0, orphan);

    h.run(() => {
      h.manager.bind('p1')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 1 }),
      });
    });
    h.settle();

    expect(namespaceOf(h.plat.raw()).allocations.p1.main.segmentId).toBe(1);
    expect(h.plat.content()[0]).toBe(orphan);
    expect(h.manager.getStatus().reservedSegments[0].reason).toMatch(
      /unclaimed envelope ghost\/main/
    );
  });

  it('keeps pages owned by modules that did not apply this global', () => {
    const s1 = sessions();
    const first = createMemoryManager({
      platform: s1.plat.platform,
      segmentIds: [0, 1],
    });
    s1.run(first, () => {
      first.bind('kept')('main', {
        version: 1,
        layer: 'critical',
        priority: 10,
        initialize: () => ({ n: 1 }),
      });
      first.bind('other')('main', {
        version: 1,
        layer: 'critical',
        priority: 9,
        initialize: () => ({ n: 2 }),
      });
    });
    s1.settle(first);
    const before = namespaceOf(s1.plat.raw());
    const keptPage = before.allocations.kept.main.segmentId;
    const envelope = s1.plat.content()[keptPage];

    // 新 global：kept 未申请，另一个高优先级模块申请；kept 的页必须保持不变。
    const second = createMemoryManager({
      platform: s1.plat.platform,
      segmentIds: [0, 1],
    });
    s1.run(second, () => {
      second.bind('newcomer')('main', {
        version: 1,
        layer: 'critical',
        priority: 100,
        initialize: () => ({ n: 3 }),
      });
    });
    s1.settle(second);

    const after = namespaceOf(s1.plat.raw());
    expect(after.allocations.newcomer.main.backend).toBe('raw');
    expect(s1.plat.content()[keptPage]).toBe(envelope);
  });

  it('expires ready handles across ticks so they cannot bypass a freeze', () => {
    const h = createHarness({ segmentIds: [0] });
    let accessor!: MemoryAccessor<{ n: number }>;
    let stale: {
      query: () => unknown;
      commit: (fn: (m: { n: number }) => void) => void;
    };
    h.run(() => {
      accessor = h.manager.bind('edge')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 0 }),
      });
    });
    h.run(() => {
      const access = accessor.access();
      if (access.status === 'ready') stale = access;
    });

    // 下一 tick：句柄已过期（随后分区还会进入迁移冻结），必须抛协议错误。
    h.run(() => {
      expect(() => stale.query()).toThrow(/cannot be used at tick/);
      expect(() => stale.commit((memory) => (memory.n = 99))).toThrow(
        /cannot be used at tick/
      );
    });
  });

  it('does not write raw memory on a clean tick even with a host Memory object', () => {
    const host: Record<string, unknown> = { other: { keep: true } };
    const h = createHarness({ getHostMemory: () => host });
    h.plat.setRaw(JSON.stringify({ other: { keep: true } }));

    h.run(() => {
      h.manager.bind('quiet')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });
    const afterFirstWrite = h.plat.raw();
    h.run();
    h.run();
    expect(h.plat.raw()).toBe(afterFirstWrite);

    // 外部替换根字段时必须合并写回，不能覆盖或丢失。
    host.other = { keep: false };
    host.added = { b: 1 };
    h.run();
    const root = JSON.parse(h.plat.raw());
    expect(root.other).toEqual({ keep: false });
    expect(root.added).toEqual({ b: 1 });
  });

  it('preempts a lower priority owner and keeps generations monotonic', () => {
    const s = sessions();
    const first = createMemoryManager({
      platform: s.plat.platform,
      segmentIds: [0],
    });
    s.run(first, () => {
      first.bind('old')('main', {
        version: 1,
        layer: 'critical',
        priority: 10,
        initialize: () => ({ n: 1 }),
      });
    });
    s.settle(first);
    const before = namespaceOf(s.plat.raw());
    const firstGeneration = before.allocations.old.main.generation;
    expect(before.allocations.old.main.backend).toBe('segment');

    // 新 global：更高优先级的申请抢占唯一页，旧所有者搬回 Raw。
    const second = createMemoryManager({
      platform: s.plat.platform,
      segmentIds: [0],
    });
    s.run(second, () => {
      second.bind('old')('main', {
        version: 1,
        layer: 'critical',
        priority: 10,
        initialize: () => ({ n: 1 }),
      });
      second.bind('urgent')('main', {
        version: 1,
        layer: 'critical',
        priority: 100,
        initialize: () => ({ n: 2 }),
      });
    });
    s.settle(second);

    const after = namespaceOf(s.plat.raw());
    expect(after.allocations.urgent.main.backend).toBe('segment');
    expect(after.allocations.old.main.backend).toBe('raw');
    expect(after.generationCounter).toBeGreaterThan(firstGeneration);
    expect(after.allocations.urgent.main.generation).toBe(
      after.generationCounter
    );
  });

  it('completes a journal without the owning module applying again', () => {
    const s = sessions();
    const first = createMemoryManager({
      platform: s.plat.platform,
      segmentIds: [0],
    });
    s.run(first, () => {
      first.bind('solo')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 5 }),
      });
    });
    // 观察一 tick、规划一 tick、copy 一 tick，然后中断（不 switch）。
    s.run(first);
    s.run(first);
    const interrupted = namespaceOf(s.plat.raw());
    expect(interrupted.migration).not.toBeNull();
    expect(interrupted.allocations.solo.main.backend).toBe('raw');

    // 新 global：模块完全不申请，恢复仍要按 journal 完成搬迁。
    const second = createMemoryManager({
      platform: s.plat.platform,
      segmentIds: [0],
    });
    s.settle(second);

    const after = namespaceOf(s.plat.raw());
    expect(after.allocations.solo.main.backend).toBe('segment');
    expect(after.migration).toBeNull();
    expect(s.plat.content()[after.allocations.solo.main.segmentId]).toContain(
      '"n":5'
    );
  });

  it('force-seals the startup window after the deferral bound', () => {
    const h = createHarness({
      segmentIds: [0],
      maxStartupDeferrals: 2,
    });
    h.run(() => {
      h.manager.bind('late')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 0 }),
      });
      h.manager.deferStartupWindow();
    });
    for (let i = 0; i < 4; i++) h.run(() => h.manager.deferStartupWindow());

    const status = h.manager.getStatus();
    expect(status.startupWindowOpen).toBe(false);
    expect(status.startupWindowForced).toBe(true);
    expect(status.startupDeferrals).toBe(2);
  });

  it('requests exactly the fixed segment set instead of unioning foreign pages', () => {
    const plat = createPlatform();
    const requests: number[][] = [];
    const platform: MemoryPlatform = {
      ...plat.platform,
      activateSegments: (ids) => {
        requests.push([...ids]);
        plat.platform.activateSegments(ids);
      },
    };
    const manager = createMemoryManager({ platform, segmentIds: [0, 1, 2] });
    manager.begin(1);
    expect(requests[0]).toEqual([0, 1, 2]);
    expect(requests[0].length).toBeLessThanOrEqual(10);
  });
});

/**
 * Logger 接入规范回归：只在状态迁移与故障上输出、同一事件只记一次、
 * 提交热路径（clean tick）不产生日志、输出端口异常不影响存储流程。
 */
describe('MemoryManager logging', () => {
  it('logs a load failure exactly once even when the tick repeats', () => {
    const sink = collecting();
    const h = createHarness({ logging: sink.logging });
    h.plat.setRaw(JSON.stringify({ memoryManager: { schemaVersion: 99 } }));
    h.run(() => {
      h.manager.bind('broken')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });
    h.run();
    h.run();

    const matches = sink
      .text()
      .split('\n')
      .filter((line) => line.includes('storage load failed'));
    expect(matches).toHaveLength(1);
  });

  it('stays silent on clean ticks and reports migration transitions at info', () => {
    const quiet = collecting();
    const h = createHarness({ segmentIds: [0], logging: quiet.logging });
    h.run(() => {
      h.manager.bind('silent')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });
    h.settle();
    // 默认等级下正常路径不输出：迁移只走 info（默认关闭）。
    expect(quiet.lines).toEqual([]);

    const verbose = collecting({ info: true });
    const h2 = createHarness({ segmentIds: [0], logging: verbose.logging });
    h2.run(() => {
      h2.manager.bind('talky')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 0 }),
      });
    });
    h2.settle();
    const text = verbose.text();
    expect(text).toContain('migration 1 start');
    expect(text).toContain('copied; awaiting verification');
    expect(text).toContain('verified; switching directory');
    expect(text).toContain('migration 1 switched');

    // clean tick 不产生任何新日志。
    const before = verbose.lines.length;
    h2.run();
    h2.run();
    expect(verbose.lines.length).toBe(before);
  });

  it('warns about a reserved page once, not every tick', () => {
    const sink = collecting();
    const h = createHarness({ segmentIds: [0, 1], logging: sink.logging });
    h.plat.platform.writeSegment(1, '{"tool":"other"}');
    h.run(() => {
      h.manager.bind('p1')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 1 }),
      });
    });
    h.settle();
    h.run();
    h.run();

    const matches = sink
      .text()
      .split('\n')
      .filter((line) => line.includes('segment 1 reserved: foreign content'));
    expect(matches).toHaveLength(1);
  });

  it('warns once per write failure message while keeping retry behaviour', () => {
    const sink = collecting();
    const h = createHarness({ logging: sink.logging });
    let accessor!: MemoryAccessor<{ n: number }>;
    h.run(() => {
      accessor = h.manager.bind('retry')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });
    h.plat.failNextWrite(new Error('memory quota'));
    h.run(() => {
      const access = accessor.access();
      if (access.status === 'ready') access.commit((memory) => (memory.n = 1));
    });
    h.plat.failNextWrite(new Error('memory quota'));
    h.run();

    const matches = sink
      .text()
      .split('\n')
      .filter((line) => line.includes('raw write failed'));
    expect(matches).toHaveLength(1);

    // 失败期间业务仍可读；恢复后写入成功且不再产生新告警。
    h.run();
    expect(namespaceOf(h.plat.raw()).rawPartitions.retry.main.payload).toEqual({
      n: 1,
    });
    expect(
      sink
        .text()
        .split('\n')
        .filter((line) => line.includes('raw write failed'))
    ).toHaveLength(1);
  });

  it('keeps working when the log output port throws', () => {
    const logging = createLogging({
      output: {
        write: () => {
          throw new Error('console down');
        },
        notify: () => {
          throw new Error('mail down');
        },
      },
    });
    const h = createHarness({ logging });
    h.plat.setRaw(JSON.stringify({ memoryManager: { schemaVersion: 99 } }));
    expect(() =>
      h.run(() => {
        h.manager.bind('boom')('main', {
          version: 1,
          layer: 'critical',
          initialize: () => ({ n: 0 }),
        });
      })
    ).not.toThrow();
    expect(h.manager.getStatus().fault).toMatch(
      /Unsupported MemoryManager schema/
    );
  });
});

/**
 * 数据安全回归（历史处理记录见 docs/changelog/2026-09-12.md）。
 *
 * 覆盖的不变量：脏数据不被旧信封覆盖、switch 后不出现"无 pending 且无数据"、
 * 旧布局版本 0 不被当作新安装、腾退页清理失败不阻断目录切换、未装载分区不参与
 * 搬迁，以及外部根字段删除传播、原型键拒绝、initialize/migrate 返回值校验、
 * 非托管页诊断。
 */
describe('MemoryManager audit closure', () => {
  const envelopeOf = (
    pluginId: string,
    localId: string,
    generation: number,
    dataVersion: number,
    payload: unknown
  ) =>
    JSON.stringify({
      schemaVersion: 1,
      owner: { pluginId, localId },
      generation,
      dataVersion,
      payload,
    });

  it('keeps dirty heap data when the segment page is temporarily invisible (P1-1)', () => {
    const s = sessions();
    const first = createMemoryManager({
      platform: s.plat.platform,
      segmentIds: [0],
    });
    s.run(first, () => {
      first.bind('dirty')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 1 }),
      });
    });
    s.settle(first);
    expect(namespaceOf(s.plat.raw()).allocations.dirty.main.backend).toBe(
      'segment'
    );

    // 新 global：分区 ready 后提交 n=2，并在本 tick 内让页不可见（提交只能保留 dirty）。
    const second = createMemoryManager({
      platform: s.plat.platform,
      segmentIds: [0],
    });
    let accessor!: MemoryAccessor<{ n: number }>;
    s.run(second, () => {
      accessor = second.bind('dirty')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 0 }),
      });
      const access = accessor.access();
      expect(access.status).toBe('ready');
      if (access.status === 'ready') access.commit((memory) => (memory.n = 2));
      s.plat.hideSegments();
    });
    expect(second.getStatus().allocations[0].pending).toBe(
      'segment-activating'
    );
    expect(second.getStatus().allocations[0].dirty).toBe(true);

    // 下一 tick 页恢复可见：必须把 n=2 落盘，而不是被旧信封回退成 n=1。
    s.run(second);
    const page = namespaceOf(s.plat.raw()).allocations.dirty.main.segmentId;
    expect(s.plat.content()[page]).toContain('"n":2');
  });

  it('recovers a partition whose data never loaded when a journal switches it (P1-2, P2-3)', () => {
    const plat = createPlatform();
    const raw = JSON.stringify({
      memoryManager: {
        schemaVersion: 1,
        generationCounter: 2,
        allocations: {
          solo: { main: { backend: 'segment', segmentId: 0, generation: 1 } },
        },
        rawPartitions: {},
        migration: {
          generation: 2,
          phase: 'switch',
          reason: 'allocation',
          moves: [
            {
              pluginId: 'solo',
              localId: 'main',
              dataVersion: 1,
              from: 'segment',
              fromSegmentId: 0,
              to: 'raw',
            },
          ],
          staged: { 'solo/main': { n: 7 } },
        },
      },
    });
    plat.setRaw(raw);
    plat.platform.writeSegment(0, envelopeOf('solo', 'main', 1, 1, { n: 7 }));
    plat.platform.activateSegments([]);
    plat.nextTick();

    const manager = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    let tick = 1;
    manager.begin(tick);
    const accessor = manager.bind('solo')('main', {
      version: 1,
      layer: 'critical',
      priority: 1,
      initialize: () => ({ n: -1 }),
    });
    expect(accessor.access().status).toBe('pending');
    manager.end(tick);
    plat.nextTick();
    tick++;

    // switch 之后不能留下"无 pending 且无数据"的失真状态：诊断必须是 loading；
    // journal 进入 cleanup（等目录落盘后再清页），不是直接消失。
    const statusAfterSwitch = manager.getStatus();
    expect(statusAfterSwitch.migration?.phase).toBe('cleanup');
    expect(statusAfterSwitch.allocations[0].pending).toBe('loading');

    // 下一 tick：从 switch 后的 Raw 分区装载，必须 ready，而不是永久 loading。
    manager.begin(tick);
    const access = accessor.access();
    expect(access.status).toBe('ready');
    if (access.status === 'ready') expect(access.query()).toEqual({ n: 7 });
    manager.end(tick);
    expect(manager.getStatus().allocations[0].pending).toBeNull();
  });

  it('skips unrecoverable partitions when planning allocation (P2-3)', () => {
    const h = createHarness({ segmentIds: [0] });
    // 页上是别人的信封：恢复必然失败，分区停在 recovery 且没有数据。
    h.plat.platform.writeSegment(
      0,
      envelopeOf('ghost', 'main', 1, 1, { n: 1 })
    );
    h.plat.setRaw(
      JSON.stringify({
        memoryManager: {
          schemaVersion: 1,
          generationCounter: 1,
          allocations: {
            broken: {
              main: { backend: 'segment', segmentId: 0, generation: 1 },
            },
          },
          rawPartitions: {},
          migration: null,
        },
      })
    );
    h.run(() => {
      h.manager.bind('broken')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 0 }),
      });
    });
    h.run();

    const status = h.manager.getStatus();
    expect(status.allocations[0].pending).toBe('recovery');
    expect(status.allocationSkipped).toContainEqual({
      pluginId: 'broken',
      localId: 'main',
      reason: 'recovery',
    });
  });

  it('refuses to treat a version 0 payload as a fresh install (P2-1)', () => {
    const h = createHarness();
    h.plat.setRaw(
      JSON.stringify({
        leviathan: {
          schemaVersion: 1,
          framework: {
            pluginVersions: {},
            pluginHealth: {},
            intentReceipts: [],
            profiler: {},
          },
          plugins: { legacy: { n: 42 } },
        },
      })
    );

    let accessor!: MemoryAccessor<{ n: number }>;
    h.run(() => {
      accessor = h.manager.bind('legacy')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });

    // 缺少 migrate：拒绝而不是用 {n:0} 覆盖导入的真实 payload。
    expect(accessor.access().status).toBe('pending');
    expect(h.manager.getStatus().allocations[0].writeError).toMatch(
      /missing migrate for stored dataVersion 0/
    );
  });

  it('keeps the directory switch when clearing the vacated page fails (P2-2)', () => {
    const sink = collecting();
    const plat = createPlatform();
    const platform: MemoryPlatform = {
      ...plat.platform,
      writeSegment: (id, value) => {
        if (value === '') throw new Error('segment write refused');
        plat.platform.writeSegment(id, value);
      },
    };
    plat.setRaw(
      JSON.stringify({
        memoryManager: {
          schemaVersion: 1,
          generationCounter: 2,
          allocations: {
            solo: { main: { backend: 'segment', segmentId: 0, generation: 1 } },
          },
          rawPartitions: {},
          migration: {
            generation: 2,
            phase: 'switch',
            reason: 'allocation',
            moves: [
              {
                pluginId: 'solo',
                localId: 'main',
                dataVersion: 1,
                from: 'segment',
                fromSegmentId: 0,
                to: 'raw',
              },
            ],
            staged: { 'solo/main': { n: 7 } },
          },
        },
      })
    );
    plat.platform.writeSegment(0, envelopeOf('solo', 'main', 1, 1, { n: 7 }));
    plat.nextTick();

    const manager = createMemoryManager({
      platform,
      segmentIds: [0],
      logging: sink.logging,
    });
    manager.begin(1);
    manager.bind('solo')('main', {
      version: 1,
      layer: 'critical',
      priority: 1,
      initialize: () => ({ n: -1 }),
    });
    expect(() => manager.end(1)).not.toThrow();

    // 清页失败：目录切换照常完成，journal 停在 cleanup 重试，页内容保持有效副本。
    const afterSwitch = JSON.parse(plat.raw()).memoryManager;
    expect(afterSwitch.allocations.solo.main.backend).toBe('raw');
    expect(afterSwitch.migration?.phase).toBe('cleanup');
    expect(manager.getStatus().allocations[0].backend).toBe('raw');
    expect(plat.content()[0]).toContain('"n":7');

    // 清理重试到上限后放弃并记录诊断，页保持"保留页"状态而不是被误回收。
    for (let tick = 2; tick <= 5; tick++) {
      manager.begin(tick);
      manager.end(tick);
      plat.nextTick();
    }
    expect(JSON.parse(plat.raw()).memoryManager.migration).toBeNull();

    // 同一代际的清理失败只在首次尝试告警（重试静默），放弃时再记一条。
    const lines = sink.text().split('\n');
    expect(
      lines.filter((line) =>
        /not visible for cleanup|cleanup failed/.test(line)
      )
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes('cleanup gave up'))
    ).toHaveLength(1);
  });

  it('propagates deletion of external root fields (P3-1)', () => {
    const host: Record<string, unknown> = { other: { keep: true } };
    const h = createHarness({ getHostMemory: () => host });
    h.plat.setRaw(JSON.stringify({ other: { keep: true } }));

    h.run(() => {
      h.manager.bind('cleaner')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });
    delete host.other;
    h.run();

    expect(JSON.parse(h.plat.raw()).other).toBeUndefined();
  });

  it('rejects prototype keys in the stored namespace (P3-2)', () => {
    const h = createHarness();
    h.plat.setRaw(
      '{"memoryManager":{"schemaVersion":1,"generationCounter":0,' +
        '"allocations":{"__proto__":{"main":{"backend":"raw","generation":0}}},' +
        '"rawPartitions":{},"migration":null}}'
    );
    h.run(() => {
      h.manager.bind('proto')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 1 }),
      });
    });

    expect(h.manager.getStatus().fault).toMatch(/Invalid allocation key/);
  });

  it('rejects non-object data returned by initialize or migrate (P3-3)', () => {
    const h = createHarness();
    h.run(() => {
      expect(() =>
        h.manager.bind('array')('main', {
          version: 1,
          layer: 'critical',
          initialize: () => [] as unknown as Record<string, never>,
        })
      ).toThrow(/must return a key-value object/);
    });
  });

  it('diagnoses pages outside the managed set instead of waiting forever (P3-5)', () => {
    const h = createHarness({ segmentIds: [0] });
    h.plat.setRaw(
      JSON.stringify({
        memoryManager: {
          schemaVersion: 1,
          generationCounter: 1,
          allocations: {
            stray: {
              main: { backend: 'segment', segmentId: 9, generation: 1 },
            },
          },
          rawPartitions: {},
          migration: null,
        },
      })
    );
    let accessor!: MemoryAccessor<{ n: number }>;
    h.run(() => {
      accessor = h.manager.bind('stray')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });

    const status = h.manager.getStatus();
    expect(status.allocations[0].pending).toBe('recovery');
    expect(status.allocations[0].writeError).toMatch(/not managed/);
    expect(accessor.access().status).toBe('pending');
  });

  it('treats an explicit priority 0 as a real priority and breaks ties by identity', () => {
    const h = createHarness({ segmentIds: [0] });
    h.run(() => {
      h.manager.bind('zero')('main', {
        version: 1,
        layer: 'critical',
        priority: 0,
        initialize: () => ({ n: 0 }),
      });
      h.manager.bind('none')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
    });
    h.settle();
    expect(namespaceOf(h.plat.raw()).allocations.zero.main.backend).toBe(
      'segment'
    );
    expect(namespaceOf(h.plat.raw()).allocations.none.main.backend).toBe('raw');

    const tie = createHarness({ segmentIds: [0] });
    tie.run(() => {
      tie.manager.bind('bbb')('main', {
        version: 1,
        layer: 'critical',
        priority: 5,
        initialize: () => ({ n: 0 }),
      });
      tie.manager.bind('aaa')('main', {
        version: 1,
        layer: 'critical',
        priority: 5,
        initialize: () => ({ n: 0 }),
      });
    });
    tie.settle();
    const allocations = namespaceOf(tie.plat.raw()).allocations;
    expect(allocations.aaa.main.backend).toBe('segment');
    expect(allocations.bbb.main.backend).toBe('raw');
  });

  it('does not rebuild the main memory when only a segment partition changes', () => {
    const h = createHarness({ segmentIds: [0] });
    let accessor!: MemoryAccessor<{ n: number }>;
    h.run(() => {
      accessor = h.manager.bind('page')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ n: 0 }),
      });
    });
    h.settle();
    const rawBefore = h.plat.raw();

    h.run(() => {
      const access = accessor.access();
      if (access.status === 'ready') access.commit((memory) => (memory.n = 5));
    });

    expect(h.plat.raw()).toBe(rawBefore);
    const page = namespaceOf(rawBefore).allocations.page.main.segmentId;
    expect(h.plat.content()[page]).toContain('"n":5');
  });

  it('aborts a migration whose payload exceeds page capacity and keeps raw data', () => {
    const h = createHarness({ segmentIds: [0] });
    let accessor!: MemoryAccessor<{ blob: string }>;
    h.run(() => {
      accessor = h.manager.bind('huge')('main', {
        version: 1,
        layer: 'critical',
        priority: 1,
        initialize: () => ({ blob: 'x'.repeat(100_001) }),
      });
    });
    h.settle();

    const namespace = namespaceOf(h.plat.raw());
    expect(namespace.allocations.huge.main.backend).toBe('raw');
    expect(namespace.rawPartitions.huge.main.payload.blob).toHaveLength(100001);
    const status = h.manager.getStatus();
    expect(status.allocations[0].writeError).toMatch(/exceeds capacity/);
    expect(status.allocations[0].pending).toBeNull();
    expect(accessor.access().status).toBe('ready');
  });
});

/** 第 2 轮审计新增发现的回归：迁移冻结、旧布局原型键、超页数分配、switch 失败注入。 */
describe('MemoryManager round-2 audit closure', () => {
  const envelopeOf = (
    pluginId: string,
    localId: string,
    generation: number,
    dataVersion: number,
    payload: unknown
  ) =>
    JSON.stringify({
      schemaVersion: 1,
      owner: { pluginId, localId },
      generation,
      dataVersion,
      payload,
    });

  it('keeps priority partitions frozen for the whole migration (P1-F)', () => {
    const s = sessions();
    const manager = createMemoryManager({
      platform: s.plat.platform,
      segmentIds: [0],
    });
    let accessor!: MemoryAccessor<{ n: number }>;
    s.run(manager, () => {
      accessor = manager.bind('frozen')('main', {
        version: 1,
        layer: 'checkpoint',
        checkpointInterval: 100,
        priority: 1,
        initialize: () => ({ n: 0 }),
      });
    });
    // checkpoint 层让分区在搬迁期间保持 dirty：冻结必须把提交挡在外面，
    // 否则 switch 会用旧快照落盘，冻结后的提交被静默丢弃。
    s.run(manager, () => {
      const access = accessor.access();
      if (access.status === 'ready') access.commit((memory) => (memory.n = 1));
    });
    expect(manager.getStatus().migration).not.toBeNull();

    for (let i = 0; i < 8; i++) {
      s.run(manager, () => {
        const status = manager.getStatus();
        // cleanup 阶段的目录已经切换，分区不再冻结；冻结断言只覆盖 copy/verify/switch。
        if (status.migration === null || status.migration.phase === 'cleanup')
          return;
        const access = accessor.access();
        expect(access.status).toBe('pending');
        if (access.status === 'pending')
          expect(['migration', 'verification']).toContain(access.reason);
      });
    }
    s.settle(manager, 20);

    const page = namespaceOf(s.plat.raw()).allocations.frozen.main.segmentId;
    expect(s.plat.content()[page]).toContain('"n":1');
  });

  it('ignores prototype keys when importing the legacy layout (P3-A)', () => {
    const sink = collecting();
    const h = createHarness({ logging: sink.logging });
    h.plat.setRaw(
      '{"leviathan":{"schemaVersion":1,"framework":{"pluginVersions":{"ok":1}},' +
        '"plugins":{"__proto__":{"n":1},"ok":{"n":2}}}}'
    );
    h.run(() => {
      const accessor = h.manager.bind('ok')('main', {
        version: 1,
        layer: 'critical',
        initialize: () => ({ n: 0 }),
      });
      expect(readyData(accessor)).toEqual({ n: 2 });
      const access = accessor.access();
      if (access.status === 'ready') access.commit((memory) => (memory.n = 3));
    });

    const namespace = namespaceOf(h.plat.raw());
    // 只有安全键被导入；序列化结果里不存在 __proto__ 记录。
    expect(Object.keys(namespace.allocations)).toEqual(['ok']);
    expect(JSON.stringify(namespace.allocations)).not.toContain('__proto__');
    expect(sink.text()).toContain(
      'legacy import skipped unsafe key: __proto__'
    );
  });

  it('ranks more than ten applications and keeps the rest on raw memory', () => {
    const h = createHarness();
    const ids = Array.from(
      { length: 12 },
      (_, index) => 'p' + String(index).padStart(2, '0')
    );
    h.run(() => {
      ids.forEach((id, index) => {
        h.manager.bind(id)('main', {
          version: 1,
          layer: 'critical',
          priority: 100 - index,
          initialize: () => ({ n: index }),
        });
      });
    });
    h.settle(120);

    const allocations = namespaceOf(h.plat.raw()).allocations;
    const onSegment = ids.filter(
      (id) => allocations[id].main.backend === 'segment'
    );
    const onRaw = ids.filter((id) => allocations[id].main.backend === 'raw');
    expect(onSegment).toHaveLength(10);
    expect(onRaw).toEqual(['p10', 'p11']);
  });

  it('keeps a valid copy when the directory write fails during switch', () => {
    const plat = createPlatform();
    plat.setRaw(
      JSON.stringify({
        memoryManager: {
          schemaVersion: 1,
          generationCounter: 2,
          allocations: {
            solo: { main: { backend: 'segment', segmentId: 0, generation: 1 } },
          },
          rawPartitions: {},
          migration: {
            generation: 2,
            phase: 'switch',
            reason: 'allocation',
            moves: [
              {
                pluginId: 'solo',
                localId: 'main',
                dataVersion: 1,
                from: 'segment',
                fromSegmentId: 0,
                to: 'raw',
              },
            ],
            staged: { 'solo/main': { n: 7 } },
          },
        },
      })
    );
    plat.platform.writeSegment(0, envelopeOf('solo', 'main', 1, 1, { n: 7 }));
    // 让页在切换 tick 可见：旧实现会立刻清空它，新实现必须等目录落盘后才清。
    plat.platform.activateSegments([0]);
    plat.nextTick();

    const manager = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    manager.begin(1);
    manager.bind('solo')('main', {
      version: 1,
      layer: 'critical',
      priority: 1,
      initialize: () => ({ n: -1 }),
    });
    plat.failNextWrite(new Error('memory full'));
    expect(() => manager.end(1)).not.toThrow();

    // 主 Memory 未落盘：存储仍是旧目录，且页里的有效信封没有被提前清空。
    const stored = JSON.parse(plat.raw()).memoryManager;
    expect(stored.allocations.solo.main.backend).toBe('segment');
    expect(plat.content()[0]).toContain('"n":7');

    // 下一 tick 重试写入：目录切换为 raw 且主 Memory 持有 payload，之后才进入清理。
    manager.begin(2);
    manager.end(2);
    plat.nextTick();
    const after = JSON.parse(plat.raw()).memoryManager;
    expect(after.allocations.solo.main.backend).toBe('raw');
    expect(after.rawPartitions.solo.main.payload).toEqual({ n: 7 });
  });
});
