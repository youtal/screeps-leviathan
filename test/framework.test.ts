import { createFramework, createErrorMapper } from '@/core/framework';
import type { LeviathanPlugin, PluginContext } from '@/core/framework';
import { createMemoryInterceptor } from '@/core/framework/memoryInterceptor';
import { createIntentBroker } from '@/core/framework/intentBroker';
import { createCpuGovernor } from '@/core/framework/cpuGovernor';

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
const plugin = (
  id: string,
  hooks: Partial<LeviathanPlugin> = {}
): LeviathanPlugin => ({
  ...hooks,
  manifest: { id, version: 1, ...hooks.manifest },
});

describe('Framework lifecycle', () => {
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

  it('rejects unknown schemas and does not overwrite them', () => {
    const h = harness();
    h.setRaw('{"leviathan":{"schemaVersion":999}}');
    h.framework.loop();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.framework.getStatus().safeMode).toBe(true);
  });

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

describe('Framework intents and CPU', () => {
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

describe('ErrorMapper', () => {
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
