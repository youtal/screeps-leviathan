/**
 * 文件摘要：验证 Framework 内核（@/core/framework）的生命周期、存储与调度契约。
 *
 * 覆盖模块：createFramework（tick 编排、注册表校验、动态启停/卸载/恢复、熔断与
 * safeMode、setup 回滚、CPU 准入）、createErrorMapper（栈映射与错误保真）、
 * memoryInterceptor（分区脏标记、序列化/解析成本、heap 根身份、迁移与 schema 校验）、
 * intentBroker（优先级仲裁、锁冲突、回执、失败隔离）、cpuGovernor（bucket 准入）。
 *
 * 覆盖边界：tick 内 begin → execute → end 的顺序与逆序收尾、注册变更延迟到 tick 边界
 * 生效、单个插件故障只影响自身与依赖者、关键插件故障停止后续提交、低 bucket 推迟普通
 * 插件、RawMemory 每 tick 至多写一次且干净 tick 不写、直接迁移抛错或 schema 未知时不得
 * 覆盖线上数据、意图回执只留在 heap、错误映射失败不影响业务异常。
 *
 * 替代实现：harness 用注入的 memoryPort（read/write/mount）替代 RawMemory，用自增的
 * game.time 推进 tick；stored() 直接构造合法的 RawMemory 快照作为测试起点；新建第二个
 * framework 实例复刻 global reset（共享同一 port 等价于持久化数据仍在）；统计成本时
 * spy JSON.stringify/JSON.parse 的实参，而不是只看最终字符串。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不需要 .secret.json，
 * 不执行真实构建与网络请求。
 */
import { createFramework, createErrorMapper } from '@/core/framework';
import type { LeviathanPlugin, PluginContext } from '@/core/framework';
import { createMemoryInterceptor } from '@/core/framework/memoryInterceptor';
import { createIntentBroker } from '@/core/framework/intentBroker';
import { createCpuGovernor } from '@/core/framework/cpuGovernor';

/**
 * 测试 harness：用 memoryPort 完全替代 RawMemory（raw 字符串 + read/write 计数），
 * 用 game.time 自增模拟 tick 推进。loadSourceMap 默认抛错表示线上没有 sourcemap，
 * 避免错误映射干扰成本断言；extra 允许用例覆盖任意 FrameworkOptions。
 * next() 是「推进一个 tick 再 loop」的唯一入口；暴露的 raw()/mounted()/write()/read()
 * 用于观察框架与存储的实际交互（写回次数、挂载的 Memory 根、解析次数）。
 */
const harness = (plugins: LeviathanPlugin[] = [], extra: any = {}) => {
  let raw = '{}';
  let used = 0;
  let mounted: any;
  const game = {
    time: 1,
    rooms: {},
    creeps: {},
    flags: {},
    powerCreeps: {},
    getObjectById: jest.fn(),
    notify: jest.fn(),
    cpu: { getUsed: () => used, limit: 20, tickLimit: 100, bucket: 10000 },
  } as unknown as Game;
  const report = jest.fn();
  const write = jest.fn((value: string) => {
    raw = value;
  });
  const read = jest.fn(() => raw);
  const port = {
    read,
    write,
    mount: (value: any) => {
      mounted = value;
    },
  };
  const framework = createFramework({
    plugins,
    getGame: () => game,
    memoryPort: port,
    report,
    loadSourceMap: () => {
      throw new Error('no map');
    },
    ...extra,
  });
  return {
    framework,
    game,
    report,
    port,
    write,
    read,
    next: () => {
      game.time++;
      framework.loop();
    },
    raw: () => raw,
    mounted: () => mounted,
    setRaw: (value: string) => {
      raw = value;
    },
    use: (value: number) => {
      used = value;
    },
  };
};
/** 测试插件工厂：统一补齐 manifest；hooks 允许只声明关心的钩子，manifest 展开在最后以便用例覆盖默认 version。 */
const plugin = (
  id: string,
  hooks: Partial<LeviathanPlugin> = {}
): LeviathanPlugin => ({
  ...hooks,
  manifest: { id, version: 1, ...hooks.manifest },
});

describe('Framework lifecycle', () => {
  /**
   * setup 阶段的订阅必须在首个 begin 事件之前完成，否则会漏掉同一 tick 内发布的事件；
   * 反过来，tick 进行中注册的新插件不能立即执行，必须推迟到下一个 tick。
   */
  it('registers all subscribers before begin events and defers new plugins until next tick', () => {
    const observed = jest.fn();
    const newHook = jest.fn();
    let h: ReturnType<typeof harness>;
    let added = false;
    h = harness([
      plugin('publisher', {
        onTickBegin: (c) => {
          c.events.publish({ scope: 'global' }, 'creep:death', {
            creepName: 'dead',
          });
          if (!added) {
            added = true;
            h.framework.register(plugin('new', { onTickExecute: newHook }));
          }
        },
      }),
      plugin('listener', {
        manifest: { id: 'listener', version: 1, requires: ['publisher'] },
        setup: (c) =>
          c.events.subscribe({ scope: 'global' }, 'creep:death', 's', observed),
      }),
    ]);
    h.framework.loop();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(newHook).not.toHaveBeenCalled();
    h.next();
    expect(newHook).toHaveBeenCalledTimes(1);
  });

  /**
   * 每个钩子的成本由 cpu.getUsed 差值计量：本用例让业务插件消耗 4、sourcemap 加载消耗 20、
   * 计划阶段整体消耗 24，用于确认错误映射的成本被单独记账，不会算进失败的插件样本。
   */
  it('keeps source map and report cost outside the failing plugin sample', () => {
    let h: ReturnType<typeof harness>;
    h = harness(
      [
        plugin('bad', {
          onTickExecute: () => {
            h.use(4);
            throw new Error('business');
          },
        }),
      ],
      {
        enableProfiler: true,
        profilerCheckpointInterval: 1,
        loadSourceMap: () => {
          h.use(24);
          return { version: 3, sources: [], names: [], mappings: '' };
        },
      }
    );
    h.framework.loop();
    const stats = JSON.parse(h.raw()).leviathan.framework.profiler;
    expect(stats['plugin.bad.tickExecute'].totalTime).toBe(4);
    expect(stats['framework.errorMapper.loadSourceMap'].totalTime).toBe(20);
    expect(stats['framework.tickExecute.plan'].totalTime).toBe(24);
  });

  /** critical 插件在提交阶段抛错必须停止后续提交（避免只执行一半的世界动作），但已进入本 tick 的插件仍要收尾清理，并让框架进入 safeMode。 */
  it('stops commits after a critical failure and cleans up entered plugins', () => {
    const commit = jest.fn(() => 0 as ScreepsReturnCode);
    const cleanup = jest.fn();
    const h = harness([
      plugin('core', {
        manifest: { id: 'core', version: 1, critical: true },
        onTickExecute: (c) => {
          c.intents.submit({
            subjectId: 'c',
            channel: 'move',
            execute: () => {
              throw new Error('critical');
            },
          });
        },
        onTickEnd: cleanup,
      }),
      plugin('other', {
        onTickExecute: (c) => {
          c.intents.submit({
            subjectId: 'd',
            channel: 'move',
            execute: commit,
          });
        },
      }),
    ]);
    h.framework.loop();
    expect(commit).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    expect(h.framework.getStatus().safeMode).toBe(true);
  });

  /** 注册顺序与传入顺序相反（[b, a] 且 b requires a），用于验证执行顺序由依赖拓扑决定；end 逆序保证资源释放与初始化对称。 */
  it('runs all begins before execution, ends in reverse order and initializes once', () => {
    const trace: string[] = [];
    const a = plugin('a', {
      manifest: {
        id: 'a',
        version: 1,
        persistence: { layer: 'critical' },
      },
      setup: () => {
        trace.push('a.setup');
      },
      onTickBegin: (c) => {
        trace.push('a.begin');
        c.persistence.commit((memory) => {
          memory.tick = c.tick;
        });
      },
      onTickExecute: () => {
        trace.push('a.execute');
      },
      onTickEnd: () => {
        trace.push('a.end');
      },
    });
    const b = plugin('b', {
      manifest: { id: 'b', version: 1, requires: ['a'] },
      setup: () => {
        trace.push('b.setup');
      },
      onTickBegin: () => {
        trace.push('b.begin');
      },
      onTickExecute: () => {
        trace.push('b.execute');
      },
      onTickEnd: () => {
        trace.push('b.end');
      },
    });
    const h = harness([b, a]);
    const loop = h.framework.loop;
    loop();
    expect(trace).toEqual([
      'a.setup',
      'b.setup',
      'a.begin',
      'b.begin',
      'a.execute',
      'b.execute',
      'b.end',
      'a.end',
    ]);
    expect(JSON.parse(h.raw()).leviathan.plugins.a.tick).toBe(1);
    loop();
    expect(trace).toHaveLength(8);
    trace.length = 0;
    h.next();
    expect(trace).toEqual([
      'a.begin',
      'b.begin',
      'a.execute',
      'b.execute',
      'b.end',
      'a.end',
    ]);
  });

  /**
   * 五种非法注册表：缺失依赖、依赖成环、id 重复、带 migrate 但不声明持久化、provides 冲突。
   * 校验失败必须整体保留旧注册表（safeMode 且不写 Memory），避免半安装状态破坏线上数据。
   */
  it.each([
    [plugin('a', { manifest: { id: 'a', version: 1, requires: ['missing'] } })],
    [
      plugin('a', { manifest: { id: 'a', version: 1, requires: ['b'] } }),
      plugin('b', { manifest: { id: 'b', version: 1, requires: ['a'] } }),
    ],
    [plugin('a'), plugin('a')],
    [plugin('a', { migrate: () => ({}) })],
    [
      plugin('a', { manifest: { id: 'a', version: 1, provides: ['x'] } }),
      plugin('b', { manifest: { id: 'b', version: 1, provides: ['x'] } }),
    ],
  ])('rejects invalid registry without writing Memory (%#)', (...plugins) => {
    const h = harness(plugins as LeviathanPlugin[]);
    h.framework.loop();
    expect(h.framework.getStatus().safeMode).toBe(true);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.report).toHaveBeenCalled();
  });

  /** 停用命令同样延迟到 tick 边界；释放顺序必须先依赖者后提供者，否则依赖方会在服务已消失之后才执行。 */
  it('applies dynamic disable next tick and disposes dependents before providers', () => {
    const trace: string[] = [];
    let h: ReturnType<typeof harness>;
    const a = plugin('a', {
      manifest: { id: 'a', version: 1, provides: ['value'] },
      setup: (c) => {
        c.services.provide('value', 7);
        c.onDispose(() => {
          trace.push('dispose.a');
        });
      },
    });
    const b = plugin('b', {
      manifest: { id: 'b', version: 1, requires: ['a'] },
      setup: (c) => {
        expect(c.services.get('value')).toBe(7);
        c.onDispose(() => {
          trace.push('dispose.b');
        });
      },
      onTickBegin: () => {
        h.framework.disable('a');
      },
      onTickExecute: () => {
        trace.push('execute.b');
      },
    });
    h = harness([a, b]);
    h.framework.loop();
    expect(trace).toEqual(['execute.b']);
    h.next();
    expect(trace).toEqual(['execute.b', 'dispose.b', 'dispose.a']);
    h.framework.enable('a');
    h.next();
    expect(trace[trace.length - 1]).toBe('execute.b');
  });

  /** 钩子抛非 Error 值（字符串）同样要被隔离：故障插件的依赖者跳过执行，无关插件照常运行，且本 tick 的 end 与 Memory 写回仍要完成。 */
  it('isolates throwing hooks, skips dependent work, still cleans up and flushes', () => {
    const end = jest.fn();
    const execute = jest.fn();
    const unrelated = jest.fn();
    const h = harness([
      plugin('a', {
        onTickBegin: () => {
          throw 'bad';
        },
        onTickEnd: end,
      }),
      plugin('b', {
        manifest: { id: 'b', version: 1, requires: ['a'] },
        onTickExecute: execute,
      }),
      plugin('c', { onTickExecute: unrelated }),
    ]);
    h.framework.loop();
    expect(execute).not.toHaveBeenCalled();
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.framework.getStatus().failures[0].message).toBe('bad');
  });

  /** 连续失败达到阈值后熔断（跳过执行），recover 是显式恢复入口；计数与熔断状态随 Memory 持久化，global reset 后仍然有效。 */
  it('opens circuit after consecutive failed ticks and supports explicit recovery', () => {
    const hook = jest.fn(() => {
      throw new Error('bad');
    });
    const h = harness([plugin('a', { onTickExecute: hook })], {
      failureThreshold: 2,
    });
    h.framework.loop();
    h.next();
    h.next();
    expect(hook).toHaveBeenCalledTimes(2);
    h.framework.recover('a');
    h.next();
    expect(hook).toHaveBeenCalledTimes(3);
  });

  /** setup 里登记的订阅由框架代理并随停用释放；重新启用会重做 setup，但不能重复订阅导致同一事件被通知多次。 */
  it('releases setup subscriptions on disable and does not duplicate them after reenable', () => {
    const listener = jest.fn();
    const h = harness([
      plugin('listener', {
        setup: (c) =>
          c.events.subscribe({ scope: 'global' }, 'creep:death', 's', listener),
      }),
      plugin('publisher', {
        onTickExecute: (c) => {
          c.events.publish({ scope: 'global' }, 'creep:death', {
            creepName: 'dead',
          });
        },
      }),
    ]);
    h.framework.loop();
    expect(listener).toHaveBeenCalledTimes(1);
    h.framework.disable('listener');
    h.next();
    expect(listener).toHaveBeenCalledTimes(1);
    h.framework.enable('listener');
    h.next();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  /** setup 中途失败必须回滚它已经提供的服务与订阅，否则后续插件会拿到半初始化的依赖。 */
  it('rolls back services and subscriptions when setup fails', () => {
    const listener = jest.fn();
    const h = harness([
      plugin('a', {
        manifest: { id: 'a', version: 1, provides: ['x'] },
        setup: (c) => {
          c.services.provide('x', 1);
          c.events.subscribe({ scope: 'global' }, 'creep:death', 'x', listener);
          throw new Error('setup');
        },
      }),
      plugin('b', {
        onTickExecute: (c) => {
          c.events.publish({ scope: 'global' }, 'creep:death', {
            creepName: 'dead',
          });
        },
      }),
    ]);
    h.framework.loop();
    h.next();
    expect(listener).not.toHaveBeenCalled();
    expect(h.framework.getStatus().failures[0].message).toContain('setup');
  });

  /** 内核是同步模型：async 钩子会在 tick 结束后继续执行并破坏状态一致性；begin 阶段也不允许提交游戏意图（此时尚未进入执行计划）。 */
  it('rejects async hooks and illegal submissions in begin', () => {
    const h = harness([
      plugin('async', { setup: async () => undefined }),
      plugin('begin', {
        onTickBegin: (c) => {
          c.intents.submit({
            subjectId: 'x',
            channel: 'move',
            execute: () => 0,
          });
        },
      }),
    ]);
    h.framework.loop();
    expect(
      h.framework
        .getStatus()
        .failures.map((f) => f.message)
        .join(' ')
    ).toMatch(/synchronous/);
    expect(
      h.framework
        .getStatus()
        .failures.map((f) => f.message)
        .join(' ')
    ).toMatch(/onTickExecute/);
  });

  /** 队列中的非法变更（卸载不存在的插件、注册缺依赖的插件）只让该次应用失败：旧注册表继续运行，并在后续 tick 恢复。 */
  it('invalid queued change preserves old registry and recovers next tick', () => {
    const hook = jest.fn();
    const h = harness([plugin('a', { onTickExecute: hook })]);
    h.framework.loop();
    h.framework.unregister('missing');
    h.next();
    expect(hook).toHaveBeenCalledTimes(2);
    h.framework.register(
      plugin('b', { manifest: { id: 'b', version: 1, requires: ['missing'] } })
    );
    h.next();
    expect(h.framework.getStatus().safeMode).toBe(true);
    h.next();
    expect(hook).toHaveBeenCalledTimes(3);
  });
});

describe('Framework memory', () => {
  /** 测试用持久插件默认采用 critical；普通 plugin() 不声明存储。 */
  const critical = (
    id: string,
    hooks: Partial<LeviathanPlugin> = {}
  ): LeviathanPlugin =>
    plugin(id, {
      ...hooks,
      manifest: {
        id,
        version: 1,
        persistence: { layer: 'critical' },
        ...hooks.manifest,
      },
    });

  /**
   * 构造与框架 schema 兼容的 RawMemory 快照，让用例从「已有持久化数据」的中间态开始，
   * 不必先跑若干 tick。framework/pluginVersions 等元数据必须齐全，否则拦截器会走
   * 迁移或 schema 拒绝路径，而不是用例想验证的分区逻辑。
   */
  const stored = (
    plugins: Record<string, unknown>,
    versions: Record<string, number>
  ) =>
    JSON.stringify({
      leviathan: {
        schemaVersion: 1,
        framework: {
          pluginVersions: versions,
          pluginHealth: {},
          intentReceipts: [],
          profiler: {},
        },
        plugins,
      },
    });

  /**
   * 直接驱动拦截器（不经 framework）以隔离脏标记逻辑：spy JSON.stringify 的实参可以区分
   * 「本次真正写出的分区」与「只是存在于 Memory 中的分区」，从而验证 clean 分区复用上次
   * 序列化片段、不参与遍历，而 write 只在确有脏分区时发生。
   */
  it('serializes only a dirty critical partition and skips clean ticks', () => {
    let raw = stored({ a: { count: 0 }, b: { stable: true } }, { a: 1, b: 1 });
    const write = jest.fn((value: string) => {
      raw = value;
    });
    const interceptor = createMemoryInterceptor({
      read: () => raw,
      write,
      mount: jest.fn(),
    });
    interceptor.begin([critical('a'), critical('b')], 1);
    expect(interceptor.flush(1)).toBe(false);
    interceptor.begin([critical('a'), critical('b')], 2);
    const a = interceptor.namespace<any>('a');
    const b = interceptor.namespace<any>('b');
    expect(Object.keys(a)).toEqual(['query', 'commit']);
    const stringify = jest.spyOn(JSON, 'stringify');
    a.commit((memory) => memory.count++);
    expect(interceptor.flush(2)).toBe(true);
    const serializedValues = stringify.mock.calls.map(([value]) => value);
    stringify.mockRestore();
    expect(serializedValues).toContain(a.query());
    expect(serializedValues).not.toContain(b.query());
    expect(JSON.parse(raw).leviathan.plugins.a.count).toBe(1);
    expect(JSON.parse(raw).leviathan.plugins.b.stable).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);

    interceptor.begin([critical('a'), critical('b')], 3);
    expect(interceptor.flush(3)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  /** checkpoint 层按 checkpointInterval 到期提交（标脏的 tick 计为第 1 tick）；未声明持久化的插件不创建分区，访问命名空间直接报错。 */
  it('delays checkpoint partitions and gives undeclared plugins no namespace', () => {
    let raw = stored({ slow: { count: 0 } }, { slow: 1 });
    const write = jest.fn((value: string) => {
      raw = value;
    });
    const slow = plugin('slow', {
      manifest: {
        id: 'slow',
        version: 1,
        persistence: { layer: 'checkpoint', checkpointInterval: 3 },
      },
    });
    const cache = plugin('cache');
    const interceptor = createMemoryInterceptor({
      read: () => raw,
      write,
      mount: jest.fn(),
    });
    interceptor.begin([slow, cache], 1);
    interceptor.namespace<any>('slow').commit((memory) => memory.count++);
    expect(() => interceptor.namespace('cache').query()).toThrow(
      'no persistence declaration'
    );
    expect(interceptor.flush(1)).toBe(false);
    interceptor.begin([slow, cache], 2);
    expect(interceptor.flush(2)).toBe(false);
    interceptor.begin([slow, cache], 3);
    expect(interceptor.flush(3)).toBe(true);
    expect(JSON.parse(raw).leviathan.plugins.slow.count).toBe(1);
    expect(JSON.parse(raw).leviathan.plugins.cache).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });

  /** 首次写入失败时脏标记必须保留，下一个 tick 重试成功后才清除；否则这次修改会在 global reset 后永久丢失。 */
  it('keeps a critical partition dirty when the storage write fails', () => {
    let raw = stored({ a: { count: 0 } }, { a: 1 });
    const write = jest
      .fn<void, [string]>()
      .mockImplementationOnce(() => {
        throw new Error('storage unavailable');
      })
      .mockImplementation((value) => {
        raw = value;
      });
    const interceptor = createMemoryInterceptor({
      read: () => raw,
      write,
      mount: jest.fn(),
    });
    interceptor.begin([critical('a')], 1);
    const memory = interceptor.namespace<any>('a');
    memory.commit((value) => value.count++);

    expect(() => interceptor.flush(1)).toThrow('storage unavailable');
    expect(JSON.parse(raw).leviathan.plugins.a.count).toBe(0);

    interceptor.begin([critical('a')], 2);
    expect(interceptor.flush(2)).toBe(true);
    expect(JSON.parse(raw).leviathan.plugins.a.count).toBe(1);
  });

  /**
   * 同一 global 生命周期内 Memory 根对象身份必须稳定（heap 引用，每实例只解析一次）；
   * 直接改写 RawMemory 模拟外部/调试器写入，只有新建 framework 实例（等价于 global reset）
   * 才会重新解析并看到外部数据；期间的计数变化说明外部值没有覆盖本轮的 heap 数据。
   */
  it('keeps one heap root, ignores external replacement until a new instance loads it', () => {
    const identities: any[] = [];
    const counter = critical('a', {
      onTickBegin: (c) => {
        identities.push(c.persistence.query());
        c.persistence.commit((memory) => {
          memory.count = (memory.count ?? 0) + 1;
        });
      },
    });
    const h = harness([counter]);
    h.framework.loop();
    h.next();
    expect(identities[0]).toBe(identities[1]);
    const edited = JSON.parse(h.raw());
    edited.leviathan.plugins.a.count = 100;
    h.setRaw(JSON.stringify(edited));
    h.next();
    expect(identities[2]).toBe(identities[1]);
    expect(JSON.parse(h.raw()).leviathan.plugins.a.count).toBe(3);
    expect(h.read).toHaveBeenCalledTimes(1);
    h.setRaw(JSON.stringify(edited));
    const reboot = createFramework({
      plugins: [counter],
      getGame: () => h.game,
      memoryPort: h.port,
      profiler: null,
    });
    h.game.time++;
    reboot.loop();
    expect(JSON.parse(h.raw()).leviathan.plugins.a.count).toBe(101);
    expect(identities[3]).not.toBe(identities[2]);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  /** 直接迁移函数抛错时不得写回 RawMemory：宁可保留旧数据并进入 safeMode，也不能用半成品覆盖仍可恢复的线上 Memory。 */
  it('does not overwrite RawMemory when a direct migration throws', () => {
    const h = harness([critical('a')]);
    h.framework.loop();
    const before = h.raw();
    h.framework.unregister('a');
    h.framework.register(
      critical('a', {
        manifest: { id: 'a', version: 2 },
        migrate: (data) => {
          (data as any).bad = true;
          throw new Error('migration');
        },
      })
    );
    h.next();
    expect(h.raw()).toBe(before);
    expect(h.framework.getStatus().safeMode).toBe(true);
  });

  /** 未知 schemaVersion 表示数据来自无法理解的版本：拒绝加载且不写回，避免把旧版本数据降级覆盖。 */
  it('rejects unknown schemas and does not overwrite them', () => {
    const h = harness();
    h.setRaw('{"leviathan":{"schemaVersion":999}}');
    h.framework.loop();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.framework.getStatus().safeMode).toBe(true);
  });

  /** 持久化值遵循原生 JSON.stringify 语义：函数等不可序列化字段被自然丢弃，而不是由框架额外定义一套过滤规则。 */
  it('uses native JSON.stringify semantics for submitted key-value data', () => {
    const h = harness([
      critical('a', {
        onTickEnd: (c) => {
          c.persistence.commit((memory) => {
            memory.kept = 1;
            memory.omitted = () => 1;
          });
        },
      }),
    ]);
    h.framework.loop();
    expect(h.framework.getStatus().safeMode).toBe(false);
    expect(JSON.parse(h.raw()).leviathan.plugins.a).toEqual({ kept: 1 });
  });

  /**
   * 解析次数按实例摊销：解析失败也只在首次尝试一次并保留失败状态（后续 begin 直接抛错），
   * 避免同一 tick 或连续 tick 反复解析大 JSON 造成 CPU 抖动。port.read 次数用于确认没有重复读取。
   */
  it('calls JSON.parse only once per interceptor, including runtime migrations', () => {
    let raw = '{}';
    const port = {
      read: jest.fn(() => raw),
      write: (value: string) => {
        raw = value;
      },
      mount: jest.fn(),
    };
    const interceptor = createMemoryInterceptor(port);
    const parse = jest.spyOn(JSON, 'parse');
    try {
      interceptor.begin([critical('a')], 1);
      interceptor.flush(1);
      interceptor.begin([critical('a')], 2);
      interceptor.flush(2);
      interceptor.begin(
        [
          critical('a', {
            manifest: { id: 'a', version: 2 },
            migrate: (memory) => ({ ...(memory as object), upgraded: true }),
          }),
        ],
        3
      );
      interceptor.flush(3);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(port.read).toHaveBeenCalledTimes(1);

      const invalidPort = {
        read: jest.fn(() => '{'),
        write: jest.fn(),
        mount: jest.fn(),
      };
      const invalid = createMemoryInterceptor(invalidPort);
      expect(() => invalid.begin([], 1)).toThrow();
      expect(() => invalid.begin([], 2)).toThrow();
      expect(parse).toHaveBeenCalledTimes(2);
      expect(invalidPort.read).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  /** 迁移标记随数据持久化：共享同一 port 的第二个拦截器实例模拟重启，仍不应重复执行迁移。 */
  it('migration runs once per schema version, independently of global reset', () => {
    let raw = '{}';
    const port = {
      read: () => raw,
      write: (v: string) => {
        raw = v;
      },
      mount: jest.fn(),
    };
    const migrate = jest.fn(() => ({ count: 1 }));
    const p = critical('a', { migrate });
    const one = createMemoryInterceptor(port);
    one.begin([p], 1);
    one.flush(1);
    one.begin([p], 2);
    one.flush(2);
    const two = createMemoryInterceptor(port);
    two.begin([p], 3);
    two.flush(3);
    expect(migrate).toHaveBeenCalledTimes(1);
  });
});

/**
 * 游戏意图经 broker 在提交阶段统一仲裁：同一对象的同一通道只允许优先级最高者执行，
 * 被拒绝的意图不回退重试（避免下一 tick 重复执行半动作）；回执只保留当前与上一 tick
 * 在 heap 中，不写 Memory。CPU 准入则按 bucket 区分普通与关键插件。
 */
describe('Framework intents and CPU', () => {
  /** 同一 subject/channel 提交两次，只有高优先级者执行；回执在 tickEnd 可读但不落 Memory，下一 tick 通过 previous() 取到本轮回执。 */
  it('arbitrates before submitting and keeps current/previous receipts in heap', () => {
    const order: string[] = [];
    let previous: any;
    let receipts: any;
    const h = harness([
      plugin('a', {
        onTickExecute: (c) => {
          previous = c.intents.previous();
          c.intents.submit({
            subjectId: 'c',
            channel: 'move',
            priority: 1,
            execute: () => {
              order.push('lose');
              return 0;
            },
          });
          c.intents.submit({
            subjectId: 'c',
            channel: 'move',
            priority: 2,
            execute: () => {
              order.push('move');
              return 0;
            },
          });
          c.intents.submit({
            subjectId: 'c',
            channel: 'heal',
            execute: () => {
              order.push('heal');
              return 0;
            },
          });
        },
        onTickEnd: (c) => {
          receipts = c.intents.receipts();
        },
      }),
    ]);
    h.framework.loop();
    expect(order).toEqual(['move', 'heal']);
    expect(receipts.map((r: any) => r.status)).toEqual([
      'rejected',
      'accepted',
      'accepted',
    ]);
    expect(JSON.parse(h.raw()).leviathan.framework.intentReceipts).toEqual([]);
    const firstReceipts = receipts;
    h.next();
    expect(previous).toEqual(firstReceipts);
  });

  /** 两个不同对象竞争同一把共享锁（energy）时只有一个能提交；broker 关闭后继续提交应抛错，防止在提交阶段插入新候选。 */
  it('uses stable tie breaking and rejects cross-object resource lock conflicts', () => {
    const broker = createIntentBroker(1);
    const a = jest.fn(() => 0 as ScreepsReturnCode);
    const b = jest.fn(() => 0 as ScreepsReturnCode);
    broker.submit('a', {
      subjectId: 'one',
      channel: 'work',
      locks: ['energy'],
      execute: a,
    });
    broker.submit('b', {
      subjectId: 'two',
      channel: 'work',
      locks: ['energy'],
      execute: b,
    });
    broker.commit(
      () => true,
      () => true,
      (_id, fn) => ({ ok: true, value: fn() })
    );
    expect(a).toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(() =>
      broker.submit('a', { subjectId: 'x', channel: 'x', execute: a })
    ).toThrow('closed');
  });

  /** 规划钩子抛错后它已提交的意图必须作废（不能执行半规划的世界动作），其他插件的意图不受影响。 */
  it('rejects proposals from failed planners and continues unrelated commits', () => {
    const bad = jest.fn(() => 0 as ScreepsReturnCode);
    const good = jest.fn(() => 0 as ScreepsReturnCode);
    const h = harness([
      plugin('a', {
        onTickExecute: (c) => {
          c.intents.submit({ subjectId: 'a', channel: 'move', execute: bad });
          throw new Error('planner');
        },
      }),
      plugin('b', {
        onTickExecute: (c) => {
          c.intents.submit({ subjectId: 'b', channel: 'move', execute: good });
        },
      }),
    ]);
    h.framework.loop();
    expect(bad).not.toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  /** 提交流程内部抛错只把该意图标记为 failed，不会回退去执行此前被仲裁拒绝的低优先级意图。 */
  it('isolates commit failure without retrying lower-priority rejected intents', () => {
    const next = jest.fn(() => 0 as ScreepsReturnCode);
    let receipt: any;
    const h = harness([
      plugin('a', {
        onTickExecute: (c) => {
          c.intents.submit({
            subjectId: 'a',
            channel: 'move',
            execute: () => {
              throw new Error('move');
            },
          });
        },
        onTickEnd: (c) => {
          receipt = c.intents.receipts()[0];
        },
      }),
      plugin('b', {
        onTickExecute: (c) => {
          c.intents.submit({ subjectId: 'b', channel: 'move', execute: next });
        },
      }),
    ]);
    h.framework.loop();
    expect(next).toHaveBeenCalledTimes(1);
    expect(receipt.status).toBe('failed');
  });

  /** bucket 低时普通插件被推迟以保住收尾预算；已准入的关键插件仍要执行 end 钩子并完成 Memory 写回；admit(true) 是低 bucket 下的豁免通道。 */
  it('defers ordinary plugins at low bucket and always executes admitted cleanup', () => {
    const ordinary = jest.fn();
    const end = jest.fn();
    let h: ReturnType<typeof harness>;
    const critical = plugin('core', {
      manifest: { id: 'core', version: 1, critical: true },
      onTickBegin: () => {
        h.use(96);
      },
      onTickEnd: end,
    });
    h = harness([critical, plugin('ordinary', { onTickExecute: ordinary })]);
    h.framework.loop();
    expect(ordinary).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(h.write).toHaveBeenCalled();
    const cpu = createCpuGovernor(() => h.game);
    h.use(0);
    h.game.cpu.bucket = 0;
    expect(cpu.admit()).toBe(false);
    expect(cpu.admit(true)).toBe(true);
  });
});

/** ErrorMapper 依赖构建产物中的 sourcemap：映射失败、上报失败或错误对象无法字符串化时，都必须保留原始业务错误。 */
describe('ErrorMapper', () => {
  /** 只提供 src/example.ts 一行映射，用于确认列号按 V8 stack 约定替换；未命中的帧原样保留；同一实例复用已加载的 map 而不重复加载。 */
  it('maps V8 columns correctly, preserves unmapped frames and caches the map', () => {
    const load = jest.fn(() => ({
      version: 3,
      names: [],
      sources: ['src/example.ts'],
      mappings: 'AAAA',
    }));
    const mapper = createErrorMapper(load, jest.fn());
    expect(mapper.mapStack('at run (main:1:1)\nat host (other:2:3)')).toBe(
      'at run (src/example.ts:1:1)\nat host (other:2:3)'
    );
    mapper.mapStack('at run (main.js:1:2)');
    expect(load).toHaveBeenCalledTimes(1);
  });

  /** 加载 map 与上报日志都抛错时，capture 仍要返回原始失败信息；错误对象的 toString 抛错也不能让 capture 本身抛出。 */
  it('preserves business failure if loading, reporting or string conversion fails', () => {
    const mapper = createErrorMapper(
      () => {
        throw new Error('map');
      },
      () => {
        throw new Error('logger');
      }
    );
    const result = mapper.capture(
      { tick: 1, pluginId: 'a', phase: 'tickBegin' },
      () => {
        throw new Error('original');
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok === false)
      expect(result.failure.message).toContain('original');
    expect(() =>
      mapper.capture({ tick: 1, pluginId: 'a', phase: 'tickEnd' }, () => {
        throw {
          toString() {
            throw new Error('toString');
          },
        };
      })
    ).not.toThrow();
  });
});
