/**
 * 文件摘要：验证 Framework 生命周期、调度、错误隔离与纯 heap 状态边界。
 * 使用最小 Game 桩推进 tick，测试不访问真实游戏或网络；旧持久化实现测试随实现移除。
 * Memory/RawMemory 禁止访问测试独立覆盖停用行为；健康状态与 Profiler 仅在实例内保存。
 */
import { createFramework } from '@/core/framework';
import { createErrorMapper } from '@/core/errorMapper';
import {
  createMemoryManager as createCoreMemoryManager,
  type MemoryManagerOptions,
} from '@/core/memoryManager';
import { createRuntime } from '@/core/runtime';
import { createLogging } from '@/core/logger';
import type { MemoryAccessor, MemoryHost } from '@/contracts/memory';
import type { MemoryPlatform } from '@/core/memoryManager/types';
import type { LeviathanPlugin, PluginContext } from '@/contracts';
import { createProfiler } from '@/core/profiler';
import type { ProfilerMemory } from '@/core/profiler/types';
import type { EnvMethods } from '@/contracts';
import { createIntentBroker } from '@/core/framework/intentBroker';
import { createCpuGovernor } from '@/core/framework/cpuGovernor';

/** 测试可独立创建存储，但仍必须在测试组合边界显式注入 Logger。 */
const createMemoryManager = (options: Omit<MemoryManagerOptions, 'logging'>) =>
  createCoreMemoryManager({ ...options, logging: createLogging() });

/** Game/RawMemory 测试桩；raw 读写计数用于断言框架完全不接触存储。 */
const harness = (plugins: LeviathanPlugin[] = [], extra: any = {}) => {
  let raw = '{}';
  let used = 0;
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
  (globalThis as any).RawMemory = { get: read, set: write };
  /** 大多数 Framework 用例不测试持久化：注入显式空端口，保留旧用例的无存储语义。 */
  const unassembledMemory: MemoryHost = {
    getStatus: () => ({ rawWriteError: null }),
    begin: () => undefined,
    end: () => undefined,
    deferStartupWindow: () => undefined,
    bind: () => () => {
      throw new Error('MemoryManager is not assembled');
    },
  };
  const {
    runtime: suppliedRuntime,
    logging,
    memory,
    profiler,
    enableProfiler,
    loadSourceMap,
    report: suppliedReport,
    ...frameworkOptions
  } = extra;
  const runtime =
    suppliedRuntime ??
    createRuntime(
      {
        platform: { getGame: () => game },
        profiler: { enabled: enableProfiler },
        errorMapper: {
          report: suppliedReport ?? report,
          loadSourceMap:
            loadSourceMap ??
            (() => {
              throw new Error('no map');
            }),
        },
      },
      {
        logging,
        memory: memory ?? unassembledMemory,
        profiler,
      }
    );
  const framework = createFramework({
    plugins,
    runtime,
    ...frameworkOptions,
  });
  return {
    framework,
    game,
    report,
    write,
    read,
    next: () => {
      game.time++;
      framework.loop();
    },
    raw: () => raw,
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
    const stats: ProfilerMemory = {};
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
        profiler: createProfiler({
          env: {
            getGame: () => h.game,
            log: { error: jest.fn() },
          } as unknown as EnvMethods,
          storage: { getMemory: () => stats },
          enable: true,
        }),
        loadSourceMap: () => {
          h.use(24);
          return { version: 3, sources: [], names: [], mappings: '' };
        },
      }
    );
    h.framework.loop();
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
      },
      setup: () => {
        trace.push('a.setup');
      },
      onTickBegin: (c) => {
        trace.push('a.begin');
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
    expect(h.write).not.toHaveBeenCalled();
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
   * 五种非法注册表：缺失依赖、依赖成环、id 重复、携带已停用的 migrate、provides 冲突。
   * 校验失败必须整体保留旧注册表（safeMode 且不写 Memory），避免半安装状态破坏线上数据。
   */
  it.each([
    [plugin('a', { manifest: { id: 'a', version: 1, requires: ['missing'] } })],
    [
      plugin('a', { manifest: { id: 'a', version: 1, requires: ['b'] } }),
      plugin('b', { manifest: { id: 'b', version: 1, requires: ['a'] } }),
    ],
    [plugin('a'), plugin('a')],
    [plugin('a', { migrate: () => ({}) } as any)],
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

  /** 钩子抛非 Error 值（字符串）同样要被隔离：故障插件的依赖者跳过执行，无关插件照常运行，且本 tick 的 end 与健康统计仍要完成。 */
  it('isolates throwing hooks, skips dependent work, still cleans up without storage', () => {
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
    expect(h.write).not.toHaveBeenCalled();
    expect(h.framework.getStatus().failures[0].message).toBe('bad');
  });

  /** 连续失败达到阈值后熔断（跳过执行），recover 是显式恢复入口；计数与熔断状态仅在实例 heap 内有效，global reset 后清空。 */
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

describe('Framework storage disabled', () => {
  it('does not read, mount or write host storage across ticks', () => {
    const get = jest.fn(() => {
      throw new Error('Memory access forbidden');
    });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Memory');
    Object.defineProperty(globalThis, 'Memory', { configurable: true, get });
    try {
      let context: PluginContext;
      const h = harness(
        [
          plugin('plain', {
            setup: (c) => {
              context = c;
            },
          }),
        ],
        { enableProfiler: true }
      );
      h.setRaw('{"leviathan":{"schemaVersion":999},"untouched":true}');
      const before = h.raw();
      h.framework.loop();
      h.next();
      expect(h.framework.getStatus().safeMode).toBe(false);
      expect(context!).not.toHaveProperty('persistence');
      expect(get).not.toHaveBeenCalled();
      expect(h.read).not.toHaveBeenCalled();
      expect(h.write).not.toHaveBeenCalled();
      expect(h.raw()).toBe(before);
      expect(Object.getOwnPropertyDescriptor(globalThis, 'Memory')?.get).toBe(
        get
      );
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'Memory', descriptor);
      else delete (globalThis as any).Memory;
    }
  });

  it('forgets circuit state when a new instance simulates global reset', () => {
    const hook = jest.fn(() => {
      throw new Error('bad');
    });
    const p = plugin('bad', { onTickExecute: hook });
    const one = harness([p], { failureThreshold: 1 });
    one.framework.loop();
    one.next();
    expect(hook).toHaveBeenCalledTimes(1);
    const two = harness([p], { failureThreshold: 1 });
    two.framework.loop();
    expect(hook).toHaveBeenCalledTimes(2);
    expect(two.read).not.toHaveBeenCalled();
  });

  it('rejects obsolete persistence configuration instead of silently ignoring it', () => {
    const setup = jest.fn();
    const h = harness([
      plugin('old', {
        manifest: { id: 'old', version: 1, persistence: { layer: 'critical' } },
        setup,
      } as any),
    ]);
    h.framework.loop();
    expect(setup).not.toHaveBeenCalled();
    expect(h.framework.getStatus().failures[0].message).toContain(
      'persistence is unavailable'
    );
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
    expect(h.raw()).toBe('{}');
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

  /** bucket 低时普通插件被推迟以保住收尾预算；已准入的关键插件仍要执行 end 钩子且不访问存储；admit(true) 是低 bucket 下的豁免通道。 */
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
    expect(h.write).not.toHaveBeenCalled();
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
    const mapper = createErrorMapper(createLogging(), {
      loadSourceMap: load,
      report: jest.fn(),
    });
    expect(mapper.mapStack('at run (main:1:1)\nat host (other:2:3)')).toBe(
      'at run (src/example.ts:1:1)\nat host (other:2:3)'
    );
    mapper.mapStack('at run (main.js:1:2)');
    expect(load).toHaveBeenCalledTimes(1);
  });

  /** 加载 map 与上报日志都抛错时，capture 仍要返回原始失败信息；错误对象的 toString 抛错也不能让 capture 本身抛出。 */
  it('preserves business failure if loading, reporting or string conversion fails', () => {
    const mapper = createErrorMapper(createLogging(), {
      loadSourceMap: () => {
        throw new Error('map');
      },
      report: () => {
        throw new Error('logger');
      },
    });
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

  /** 默认报告出口必须在创建映射器时派生一次作用域日志器，故障密集时不能反复重建。 */
  it('derives the default scope logger once per mapper instance', () => {
    const error = jest.fn();
    const scope = jest.fn(() => ({
      debug: jest.fn(),
      warn: jest.fn(),
      error,
      success: jest.fn(),
      info: jest.fn(),
      report: jest.fn(),
      isEnabled: jest.fn(() => true),
    }));
    const mapper = createErrorMapper(
      { scope } as unknown as Parameters<typeof createErrorMapper>[0],
      { loadSourceMap: () => ({}) }
    );

    const meta = { tick: 1, pluginId: 'a', phase: 'tickExecute' } as const;
    mapper.capture(meta, () => {
      throw new Error('first');
    });
    mapper.capture(meta, () => {
      throw new Error('second');
    });

    expect(scope).toHaveBeenCalledTimes(1);
    expect(scope).toHaveBeenCalledWith('ErrorMapper');
    expect(error).toHaveBeenCalledTimes(2);
  });
});

/** Framework 与 MemoryManager 的接线：框架按 pluginId 绑定申请入口并在 tick 边界驱动存储。 */
describe('Framework memory integration', () => {
  it('exposes raw write failure and recovery without blocking corrective plugin work', () => {
    let raw = '{}';
    let accessor: MemoryAccessor<{ blob: string }>;
    let blob = 'x'.repeat(2_200_000);
    const manager = createMemoryManager({
      segmentIds: [],
      platform: {
        readRaw: () => raw,
        writeRaw: (text) => { raw = text; },
        readSegments: () => ({}),
        writeSegment: () => undefined,
        activeSegments: () => [],
        activateSegments: () => undefined,
      },
    });
    const execute = jest.fn(() => {
      const access = accessor.access();
      expect(access.status).toBe('ready');
      if (access.status === 'ready') access.commit((data) => { data.blob = blob; });
    });
    const h = harness([plugin('writer', {
      setup(context) {
        accessor = context.memory('main', {
          version: 1, layer: 'critical', initialize: () => ({ blob: '' }),
        });
      },
      onTickExecute: execute,
    })], { memory: manager });
    h.next();
    h.next();
    const failed = h.framework.getStatus();
    expect(failed.memory.rawWriteError).toContain('exceeds');
    expect(failed.safeMode).toBe(false);
    expect(failed.failures).toEqual([]);
    expect(manager.getStatus().allocations[0].dirty).toBe(true);
    expect(raw).toBe('{}');
    failed.memory.rawWriteError = null;
    expect(h.framework.getStatus().memory.rawWriteError).toContain('exceeds');

    blob = 'recovered';
    h.next();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(h.framework.getStatus().memory.rawWriteError).toBeNull();
    expect(manager.getStatus().allocations[0].dirty).toBe(false);
    expect(JSON.parse(raw).memoryManager.rawPartitions.writer.main.payload.blob)
      .toBe('recovered');
  });

  /** 只服务本组用例的假平台：raw 整串 + 一 tick 延迟可见的 Segment。 */
  const createPlatform = () => {
    let raw = '{}';
    const content: Record<number, string> = {};
    let visible: number[] = [];
    let requested: number[] = [];
    const platform: MemoryPlatform = {
      readRaw: () => raw,
      writeRaw: (value) => {
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
      nextTick: () => {
        visible = [...requested];
      },
    };
  };

  it('binds applications by plugin id and persists them through a reset', () => {
    const plat = createPlatform();
    let accessor: MemoryAccessor<{ ticks: number }> | undefined;
    const consumer = plugin('consumer', {
      setup(context) {
        accessor = context.memory('main', {
          version: 1,
          layer: 'critical',
          priority: 5,
          initialize: () => ({ ticks: 0 }),
        });
      },
      onTickExecute() {
        const access = accessor!.access();
        if (access.status === 'ready')
          access.commit((memory) => (memory.ticks += 1));
      },
    });

    const first = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    const h = harness([consumer], { memory: first });
    h.next();
    h.next();
    h.next();
    // 迁移需要跨 tick 完成，但每次 begin 都会推进；这里确认最终落在 Segment 上。
    for (let i = 0; i < 5; i++) {
      plat.nextTick();
      h.next();
    }

    const namespace = JSON.parse(plat.raw()).memoryManager;
    expect(first.getStatus().allocations[0].pluginId).toBe('consumer');
    expect(namespace.allocations.consumer.main.backend).toBe('segment');

    // 模拟 global reset：新管理器读同一份存储，插件重新申请后数据延续。
    const second = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    let restored: MemoryAccessor<{ ticks: number }> | undefined;
    const restarted = plugin('consumer', {
      setup(context) {
        restored = context.memory('main', {
          version: 1,
          layer: 'critical',
          priority: 5,
          initialize: () => ({ ticks: -1 }),
        });
      },
    });
    const h2 = harness([restarted], { memory: second });
    h2.next();
    const restoredAccess = restored!.access();
    expect(restoredAccess.status).toBe('ready');
    if (restoredAccess.status === 'ready')
      expect(restoredAccess.query().ticks).toBeGreaterThan(0);
  });

  it('defers the memory startup window while plugins are not admitted', () => {
    const plat = createPlatform();
    const manager = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
    });
    const consumer = plugin('consumer', {
      setup(context) {
        context.memory('main', {
          version: 1,
          layer: 'critical',
          priority: 5,
          initialize: () => ({ ticks: 0 }),
        });
      },
    });
    const h = harness([consumer], { memory: manager });

    // 低 bucket：普通插件不被准入，setup 未执行 → 申请窗口必须保持开启。
    h.game.cpu.bucket = 0;
    h.next();
    expect(manager.getStatus().startupWindowOpen).toBe(true);

    // bucket 恢复后插件正常 setup 并申请，本 tick 收尾即可封存窗口。
    h.game.cpu.bucket = 10000;
    plat.nextTick();
    h.next();
    expect(manager.getStatus().startupWindowOpen).toBe(false);
  });

  it('isolates memory lifecycle failures without wedging the loop', () => {
    // end 抛错：业务照常执行，下一 tick 仍能进入（running 已复位）。
    const onTickExecute = jest.fn();
    const endBoom = {
      begin: jest.fn(),
      end: jest.fn(() => {
        throw new Error('end boom');
      }),
      deferStartupWindow: jest.fn(),
      getStatus: () => ({ rawWriteError: null }),
      bind: jest.fn(),
    };
    const h = harness([plugin('consumer', { onTickExecute })], {
      memory: endBoom,
    });
    expect(() => h.next()).not.toThrow();
    expect(() => h.next()).not.toThrow();
    expect(endBoom.begin).toHaveBeenCalledTimes(2);
    expect(endBoom.end).toHaveBeenCalledTimes(2);
    expect(onTickExecute).toHaveBeenCalledTimes(2);
    expect(h.framework.getStatus().failures.length).toBeGreaterThan(0);

    // begin 抛错：按内核故障进入安全模式，但下一 tick 依旧能进入而不是永久不可重入。
    const beginBoom = {
      begin: jest.fn(() => {
        throw new Error('begin boom');
      }),
      end: jest.fn(),
      deferStartupWindow: jest.fn(),
      getStatus: () => ({ rawWriteError: null }),
      bind: jest.fn(),
    };
    const h2 = harness([plugin('consumer', {})], { memory: beginBoom });
    expect(() => h2.next()).not.toThrow();
    expect(() => h2.next()).not.toThrow();
    expect(beginBoom.begin).toHaveBeenCalledTimes(2);
    expect(beginBoom.end).toHaveBeenCalledTimes(2);
  });

  it('defers the startup window when a plugin setup fails before applying', () => {
    const plat = createPlatform();
    const manager = createMemoryManager({
      platform: plat.platform,
      segmentIds: [0],
      maxStartupDeferrals: 5,
    });
    let attempts = 0;
    const flaky = plugin('flaky', {
      setup(context) {
        attempts++;
        if (attempts === 1) throw new Error('first setup fails');
        context.memory('main', {
          version: 1,
          layer: 'critical',
          priority: 1,
          initialize: () => ({ n: 0 }),
        });
      },
    });
    const h = harness([flaky], { memory: manager });

    h.next();
    expect(manager.getStatus().startupWindowOpen).toBe(true);

    plat.nextTick();
    h.next();
    expect(manager.getStatus().startupWindowOpen).toBe(false);
  });

  it('reports a configuration error when no memory manager is assembled', () => {
    const consumer = plugin('consumer', {
      setup(context) {
        context.memory('main', {
          version: 1,
          layer: 'critical',
          initialize: () => ({ ticks: 0 }),
        });
      },
    });
    const h = harness([consumer]);
    h.next();

    const failures = h.framework.getStatus().failures;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].message).toMatch(/MemoryManager is not assembled/);
  });
});
