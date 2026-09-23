/**
 * 文件摘要：验证 Framework 生命周期、调度、错误隔离、任务驱动接入与纯 heap 状态边界。
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
import { runInNewContext } from 'node:vm';
import { createLogging } from '@/core/logger';
import type { MemoryAccessor, MemoryHost } from '@/contracts/memory';
import type {
  CpuBudget,
  LeviathanPlugin,
  PluginContext,
  TaskHost,
} from '@/contracts';
import { createProfiler } from '@/core/profiler';
import type { ProfilerMemory } from '@/core/profiler/types';
import type { EnvMethods } from '@/contracts';
import { createIntentBroker } from '@/core/framework/intentBroker';
import { createCpuGovernor } from '@/core/framework/cpuGovernor';
import { defineService } from '@/contracts';

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
    getStatus: () => ({ loadError: null, rawWriteError: null }),
    begin: () => undefined,
    end: () => undefined,
    bind: () => () => {
      throw new Error('MemoryManager is not assembled');
    },
  };
  const {
    runtime: suppliedRuntime,
    logging,
    memory,
    profiler,
    tasks,
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
        // 未指定时由 Runtime 创建真实 TaskScheduler；任务相关用例可注入记录调用的替身。
        tasks,
      }
    );
  const framework = createFramework({
    plugins,
    runtime,
    ...frameworkOptions,
  });
  return {
    framework,
    runtime,
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

  it('resolves a typed service token through the existing ownership and availability checks', () => {
    const token = defineService<{ count: number }>('counter');
    const observed: number[] = [];
    const h = harness([
      plugin('provider', {
        manifest: { id: 'provider', version: 1, provides: [token.name] },
        setup: (context) => context.services.provide(token, { count: 7 }),
      }),
      plugin('consumer', {
        manifest: { id: 'consumer', version: 1, requires: ['provider'] },
        onTickExecute: (context) => {
          observed.push(context.services.get(token).count);
          expect(context.services.get<{ count: number }>('counter').count).toBe(
            7
          );
        },
      }),
      plugin('undeclared', {
        onTickExecute: (context) => {
          expect(() => context.services.get(token)).toThrow(
            'Undeclared service dependency: counter'
          );
        },
      }),
    ]);
    h.framework.loop();
    expect(observed).toEqual([7]);
    h.framework.disable('provider');
    h.next();
    expect(observed).toEqual([7]);
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

  /** A06：堆栈同时是映射缓存的键，公开入口必须和 capture 一样限长，否则缓存按输入长度增长。 */
  it('truncates oversized stacks at the public mapStack entry', () => {
    const mapper = createErrorMapper(createLogging(), {
      loadSourceMap: () => ({
        version: 3,
        names: [],
        sources: ['src/example.ts'],
        mappings: 'AAAA',
      }),
      report: jest.fn(),
    });

    const mapped = mapper.mapStack('x'.repeat(20000));
    expect(mapped.length).toBe(16384);
    // 截断发生在查缓存之前：同一条超长堆栈重复映射仍命中同一个缓存项。
    expect(mapper.mapStack('x'.repeat(30000))).toBe(mapped);
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

  /** G02：默认日志出口按插件与阶段去重，成功后重置；注入的 report 每次都收到。 */
  it('deduplicates repeated failures in the default report and resets after success', () => {
    const lines: string[] = [];
    const mapper = createErrorMapper(
      createLogging({ output: { write: (line) => lines.push(line) } }),
      { loadSourceMap: () => ({}) }
    );
    const meta = { tick: 1, pluginId: 'a', phase: 'tickExecute' } as const;
    const fail = (message: string) =>
      mapper.capture(meta, () => {
        throw new Error(message);
      });
    fail('storage broken');
    fail('storage broken');
    fail('storage broken');
    expect(lines).toHaveLength(1);
    fail('another cause'); // 原因变化时重新记录
    expect(lines).toHaveLength(2);
    mapper.capture(meta, () => 'recovered'); // 成功一次即重置
    fail('another cause');
    expect(lines).toHaveLength(3);
    // 其他插件或阶段互不影响。
    mapper.capture({ ...meta, phase: 'tickEnd' }, () => {
      throw new Error('another cause');
    });
    expect(lines).toHaveLength(4);

    const report = jest.fn();
    const custom = createErrorMapper(createLogging(), {
      loadSourceMap: () => ({}),
      report,
    });
    for (let i = 0; i < 3; i++)
      custom.capture(meta, () => {
        throw new Error('same');
      });
    expect(report).toHaveBeenCalledTimes(3);
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
/** S02：critical 订阅者失败要在发布者的钩子返回前生效，后续业务动作不能再执行。 */
describe('Framework critical event listener failure', () => {
  const criticalListener = (trace: string[]) =>
    plugin('critical', {
      manifest: { id: 'critical', version: 1, critical: true },
      setup: (c) => {
        c.events.subscribe({ scope: 'global' }, 'creep:spawn', 'broken', () => {
          trace.push('listener');
          throw new Error('critical listener failed');
        });
      },
    });
  const worker = (trace: string[]) =>
    plugin('worker', {
      onTickExecute: (c) => {
        c.intents.submit({
          subjectId: 'w',
          channel: 'move',
          execute: () => {
            trace.push('business');
            return 0 as ScreepsReturnCode;
          },
        });
      },
    });
  const spawn = { creepName: 'probe' };

  it.each(['onTickBegin', 'onTickExecute'] as const)(
    'skips later business work when the event is published from %s',
    (hook) => {
      const trace: string[] = [];
      const h = harness([
        criticalListener(trace),
        plugin('publisher', {
          [hook]: (c: any) =>
            c.events.publish({ scope: 'global' }, 'creep:spawn', spawn),
        }),
        worker(trace),
      ]);
      h.framework.loop();
      expect(trace).toEqual(['listener']);
      const status = h.framework.getStatus();
      expect(status.safeMode).toBe(true);
      expect(status.failures[0].pluginId).toBe('critical');
    }
  );

  it('stops the remaining intents when the event is published during commit', () => {
    const trace: string[] = [];
    const h = harness([
      criticalListener(trace),
      plugin('publisher', {
        onTickExecute: (c) => {
          c.intents.submit({
            subjectId: 'p',
            channel: 'move',
            execute: () => {
              c.events.publish({ scope: 'global' }, 'creep:spawn', spawn);
              return 0 as ScreepsReturnCode;
            },
          });
        },
      }),
      worker(trace),
    ]);
    h.framework.loop();
    expect(trace).toEqual(['listener']);
    expect(h.framework.getStatus().safeMode).toBe(true);
  });

  it('keeps isolating failures of non-critical subscribers', () => {
    const trace: string[] = [];
    const h = harness([
      plugin('flaky', {
        setup: (c) => {
          c.events.subscribe({ scope: 'global' }, 'creep:spawn', 'x', () => {
            throw new Error('non-critical');
          });
        },
      }),
      plugin('publisher', {
        onTickBegin: (c) =>
          c.events.publish({ scope: 'global' }, 'creep:spawn', spawn),
      }),
      worker(trace),
    ]);
    h.framework.loop();
    expect(trace).toEqual(['business']);
    expect(h.framework.getStatus().safeMode).toBe(false);
  });
});

describe('Framework memory integration', () => {
  /**
   * 真实 MemoryManager 的平台：raw 整串 + 从 harness 的 Game 读取真实 tick。
   * 管理器在 harness 之前创建，因此 tick 源通过 attach 延迟绑定。
   */
  const createPlatform = (initial = '{}') => {
    let raw = initial;
    let game: { time: number } = { time: 1 };
    const manager = createMemoryManager({
      platform: {
        readRaw: () => raw,
        writeRaw: (text) => {
          raw = text;
        },
        getTick: () => game.time,
      },
    });
    return {
      manager,
      raw: () => raw,
      attach: (target: { time: number }) => {
        game = target;
      },
    };
  };
  const counterInit = () => ({ n: 0 });
  const counterOptions = { version: 1, initialize: counterInit };

  /** S04：停用再启用与 setup 重试都复用同一声明，数据延续且不重复初始化。 */
  it('reapplies a stable memory declaration after disable/enable and a failed setup', () => {
    const plat = createPlatform();
    const initialize = jest.fn(counterInit);
    const options = { version: 1, initialize };
    let setups = 0;
    let executions = 0;
    let accessor: MemoryAccessor<{ n: number }>;
    const h = harness(
      [
        plugin('consumer', {
          setup(context) {
            accessor = context.memory('main', options);
            // 首次 setup 在申请成功后失败：重试必须复用同一声明而不是冲突。
            if (++setups === 1) throw new Error('setup retry');
          },
          onTickExecute() {
            executions++;
            accessor.commit((data) => void data.n++);
          },
        }),
      ],
      { memory: plat.manager }
    );
    plat.attach(h.game);
    for (let i = 0; i < 6; i++) h.next();
    h.framework.disable('consumer');
    h.next();
    h.framework.enable('consumer');
    for (let i = 0; i < 3; i++) h.next();

    const failures = h.framework.getStatus().failures;
    expect(failures.some((f) => /conflicting declaration/.test(f.message))).toBe(false);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(executions).toBeGreaterThan(1);
    const stored = JSON.parse(plat.raw()).memoryManager.partitions.consumer.main;
    expect(stored.payload.n).toBe(executions);
  });

  it('exposes raw write failure and recovery without blocking corrective plugin work', () => {
    const plat = createPlatform();
    let accessor: MemoryAccessor<{ blob: string }>;
    let blob = 'x'.repeat(2_200_000);
    const execute = jest.fn(() => accessor.commit('blob', blob));
    const h = harness(
      [
        plugin('writer', {
          setup(context) {
            accessor = context.memory('main', {
              version: 1,
              initialize: () => ({ blob: '' }),
            });
          },
          onTickExecute: execute,
        }),
      ],
      { memory: plat.manager }
    );
    plat.attach(h.game);
    h.next();
    h.next();
    const failed = h.framework.getStatus();
    expect(failed.memory.rawWriteError).toMatch(/^capacity: .*exceeds/);
    expect(failed.memory.loadError).toBeNull();
    expect(failed.safeMode).toBe(false);
    expect(failed.failures).toEqual([]);
    expect(plat.manager.getStatus().dirty).toEqual([{ owner: 'writer', localId: 'main' }]);
    expect(plat.raw()).toBe('{}');
    failed.memory.rawWriteError = null;
    expect(h.framework.getStatus().memory.rawWriteError).toMatch(/exceeds/);

    blob = 'recovered';
    h.next();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(h.framework.getStatus().memory.rawWriteError).toBeNull();
    expect(plat.manager.getStatus().dirty).toEqual([]);
    expect(JSON.parse(plat.raw()).memoryManager.partitions.writer.main.payload.blob).toBe(
      'recovered'
    );
  });

  it('binds applications by plugin id and persists them through a reset', () => {
    const plat = createPlatform();
    let accessor: MemoryAccessor<{ ticks: number }> | undefined;
    const consumer = plugin('consumer', {
      setup(context) {
        accessor = context.memory('main', {
          version: 1,
          initialize: () => ({ ticks: 0 }),
        });
      },
      onTickExecute() {
        accessor!.commit((memory) => (memory.ticks += 1));
      },
    });
    const h = harness([consumer], { memory: plat.manager });
    plat.attach(h.game);
    h.next();
    h.next();
    h.next();
    expect(plat.manager.getStatus().partitions[0]).toMatchObject({
      owner: 'consumer',
      localId: 'main',
      applied: true,
    });

    // global reset：新管理器读同一份存储，插件重新申请后数据延续，initialize 不再执行。
    const second = createMemoryManager({
      platform: {
        readRaw: plat.raw,
        writeRaw: () => undefined,
        getTick: () => h2.game.time,
      },
    });
    let restored: MemoryAccessor<{ ticks: number }> | undefined;
    const initialize = jest.fn(() => ({ ticks: -1 }));
    const restarted = plugin('consumer', {
      setup(context) {
        restored = context.memory('main', { version: 1, initialize });
      },
    });
    const h2 = harness([restarted], { memory: second });
    h2.next();
    expect(restored!.query().ticks).toBe(3);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('enters safe mode on load failure, keeps storage intact and does not wedge the loop', () => {
    const plat = createPlatform('{broken');
    const setup = jest.fn();
    const h = harness([plugin('consumer', { setup })], { memory: plat.manager });
    plat.attach(h.game);
    h.next();
    h.next();
    const status = h.framework.getStatus();
    expect(status.safeMode).toBe(true);
    expect(status.memory.loadError).toMatch(/JSON/);
    expect(setup).not.toHaveBeenCalled();
    expect(plat.raw()).toBe('{broken');
  });

  it('routes application failures into the plugin error boundary', () => {
    const plat = createPlatform(
      JSON.stringify({
        memoryManager: { schemaVersion: 2, partitions: { consumer: { main: { dataVersion: 2, payload: {} } } } },
      })
    );
    const h = harness(
      [
        plugin('consumer', {
          setup(context) {
            context.memory('main', counterOptions);
          },
        }),
      ],
      { memory: plat.manager }
    );
    plat.attach(h.game);
    h.next();
    const status = h.framework.getStatus();
    expect(status.safeMode).toBe(false);
    expect(status.failures[0]).toMatchObject({ pluginId: 'consumer', phase: 'setup' });
    expect(status.failures[0].message).toMatch(/missing migrate for stored dataVersion 2/);
  });

  it('isolates memory lifecycle failures without wedging the loop', () => {
    // end 抛错：业务照常执行，下一 tick 仍能进入（runningTick 已复位）。
    const onTickExecute = jest.fn();
    const endBoom: MemoryHost = {
      begin: jest.fn(),
      end: jest.fn(() => {
        throw new Error('end boom');
      }),
      getStatus: () => ({ loadError: null, rawWriteError: null }),
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

    // begin 抛错：按宿主故障进入安全模式，但下一 tick 依旧能进入而不是永久不可重入。
    const beginBoom: MemoryHost = {
      begin: jest.fn(() => {
        throw new Error('begin boom');
      }),
      end: jest.fn(),
      getStatus: () => ({ loadError: 'begin boom', rawWriteError: null }),
      bind: jest.fn(),
    };
    const h2 = harness([plugin('consumer', {})], { memory: beginBoom });
    expect(() => h2.next()).not.toThrow();
    expect(() => h2.next()).not.toThrow();
    expect(beginBoom.begin).toHaveBeenCalledTimes(2);
    expect(beginBoom.end).toHaveBeenCalledTimes(2);
    expect(h2.framework.getStatus().safeMode).toBe(true);
  });

  it('recovers the loop and memory after a hard termination that skips finally blocks', () => {
    const plat = createPlatform();
    let hang = false;
    let accessor: MemoryAccessor<{ n: number }>;
    const h = harness(
      [
        plugin('consumer', {
          setup(context) {
            accessor = context.memory('main', counterOptions);
          },
          onTickExecute() {
            accessor.commit((data) => {
              data.n++;
              if (hang) for (;;);
            });
          },
        }),
      ],
      { memory: plat.manager }
    );
    plat.attach(h.game);
    h.next();
    hang = true;
    h.game.time++;
    // vm 超时终止执行时不运行任何 catch/finally，等价于引擎 CPU 硬终止且 heap 保留。
    expect(() =>
      runInNewContext('loop()', { loop: h.framework.loop }, { timeout: 50 })
    ).toThrow(/timed out/);
    // 同一 tick 内再次进入仍判为重入；下一个真实 tick 自动恢复，不被遗留锁永久锁死。
    expect(() => h.framework.loop()).toThrow(/not reentrant/);
    hang = false;
    h.next();
    h.next();
    const status = h.framework.getStatus();
    expect(status.safeMode).toBe(false);
    expect(status.failures).toEqual([]);
    // 终止 tick 中回调已做的修改保留在脏数据中，随后提交；共计 4 次递增。
    expect(JSON.parse(plat.raw()).memoryManager.partitions.consumer.main.payload.n).toBe(4);
  });

  /** N2：暂时性 initialize 失败触发熔断后，条件恢复并 recover 即可重新申请，无需 global reset。 */
  it('recovers a plugin whose initialize failed transiently after recover()', () => {
    const plat = createPlatform();
    let visible = false;
    const initialize = () => {
      if (!visible) throw new Error('room not visible');
      return { n: 0 };
    };
    const options = { version: 1, initialize };
    let accessor: MemoryAccessor<{ n: number }> | undefined;
    const h = harness(
      [
        plugin('seeded', {
          setup(context) {
            accessor = context.memory('main', options);
          },
          onTickExecute() {
            accessor!.commit((data) => void data.n++);
          },
        }),
      ],
      { memory: plat.manager, failureThreshold: 3 }
    );
    plat.attach(h.game);
    for (let i = 0; i < 4; i++) h.next(); // 连续失败达到阈值，熔断打开
    expect(accessor).toBeUndefined();
    visible = true;
    h.next(); // 熔断中，不重试
    expect(accessor).toBeUndefined();
    h.framework.recover('seeded');
    h.next();
    h.next();
    expect(h.framework.getStatus().failures).toEqual([]);
    expect(JSON.parse(plat.raw()).memoryManager.partitions.seeded.main.payload.n).toBe(2);
  });

  /** G01：事件回调中 setup 专属接口一律拒绝；按阶段判定的意图提交保持不变。 */
  it('rejects setup-only APIs inside event callbacks and keeps cleanup ownership', () => {
    const trace: string[] = [];
    const watcher = plugin('watcher', {
      manifest: { id: 'watcher', version: 1, provides: ['late'] },
      setup(context) {
        context.services.provide('late', {});
        context.events.subscribe(
          { scope: 'global' },
          'creep:spawn',
          'watch',
          () => {
            for (const [name, action] of [
              [
                'onDispose',
                () => context.onDispose(() => trace.push('watcher cleanup')),
              ],
              [
                'subscribe',
                () =>
                  context.events.subscribe(
                    { scope: 'global' },
                    'creep:death',
                    'late',
                    () => undefined
                  ),
              ],
              ['provide', () => context.services.provide('late', {})],
            ] as const) {
              try {
                action();
                trace.push(name + ' allowed');
              } catch {
                trace.push(name + ' rejected');
              }
            }
          }
        );
        context.events.subscribe(
          { scope: 'global' },
          'creep:death',
          'intent',
          () => {
            context.intents.submit({
              subjectId: 'c1',
              channel: 'move',
              execute: () => OK,
            });
            trace.push('intent submitted');
          }
        );
      },
    });
    const h = harness([watcher]);
    h.next();
    const publisher = plugin('publisher', {
      setup(context) {
        context.events.publish({ scope: 'global' }, 'creep:spawn', {
          creepName: 'x',
          roomName: 'W1N1',
          spawnId: 's' as Id<StructureSpawn>,
        } as never);
      },
      onTickExecute(context) {
        context.events.publish({ scope: 'global' }, 'creep:death', {
          creepName: 'x',
        } as never);
      },
    });
    h.framework.register(publisher);
    h.next();
    h.framework.disable('publisher');
    h.next();
    expect(trace).toEqual([
      'onDispose rejected',
      'subscribe rejected',
      'provide rejected',
      'intent submitted',
    ]);
    expect(h.framework.getStatus().failures).toEqual([]);
  });

  it('reports a configuration error when no memory manager is assembled', () => {
    const consumer = plugin('consumer', {
      setup(context) {
        context.memory('main', counterOptions);
      },
    });
    const h = harness([consumer]);
    h.next();

    const failures = h.framework.getStatus().failures;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].message).toMatch(/MemoryManager is not assembled/);
  });
});

/** G03：服务对象属于提供者的某次激活，使用者的激活必须包含在其中。 */
describe('Framework service activation', () => {
  it('releases requires consumers when a provider instance is replaced in the same batch', () => {
    let providerSetups = 0;
    const makeProvider = (label: string): LeviathanPlugin => ({
      manifest: { id: 'p', version: 1, provides: ['svc'] },
      setup(ctx) {
        providerSetups++;
        ctx.services.provide('svc', { label });
      },
    });
    let consumerSetups = 0;
    let cached: { label: string } | undefined;
    const seen: string[] = [];
    const consumer: LeviathanPlugin = {
      manifest: { id: 'c', version: 1, requires: ['p'] },
      setup(ctx) {
        consumerSetups++;
        cached = ctx.services.get<{ label: string }>('svc');
      },
      onTickExecute() {
        seen.push(cached!.label);
      },
    };

    const h = harness([makeProvider('old'), consumer]);
    h.next();
    // 同一批命令内替换提供者：提供者仍在启用集合中，级联只能来自“实例被替换”的判定。
    h.framework.unregister('p');
    h.framework.register(makeProvider('new'));
    h.next();
    h.next();

    expect(providerSetups).toBe(2);
    expect(consumerSetups).toBe(2);
    // 替换后使用者立刻改用新实例，不会继续持有已释放的服务对象。
    expect(seen).toEqual(['old', 'new', 'new']);
    expect(h.framework.getStatus().failures).toEqual([]);
  });
});

describe('Framework task driving', () => {
  /** 记录调用的 TaskHost 替身；未覆盖的方法为空实现，bind 出的入口在这些用例中不应被使用。 */
  const stubTasks = (overrides: Partial<TaskHost> = {}): TaskHost => ({
    bind: () => ({
      submit: () => {
        throw new Error('stub scheduler');
      },
      get: () => undefined,
      release: () => undefined,
    }),
    persist: () => undefined,
    drive: () => undefined,
    releaseOwner: () => undefined,
    getStatus: () => ({ queued: 0, running: 0 }),
    ...overrides,
  });

  it('persists task records before MemoryHost.end and drives tasks after it, with the plugin CpuBudget', () => {
    const order: string[] = [];
    const budgets: CpuBudget[] = [];
    let pluginBudget: CpuBudget | undefined;
    const memory: MemoryHost = {
      getStatus: () => ({ loadError: null, rawWriteError: null }),
      begin: () => {
        order.push('begin');
      },
      end: () => {
        order.push('end');
      },
      bind: () => () => {
        throw new Error('MemoryManager is not assembled');
      },
    };
    const tasks = stubTasks({
      persist: (tick) => {
        order.push('persist:' + tick);
      },
      drive: (tick, cpu) => {
        order.push('drive:' + tick);
        budgets.push(cpu);
      },
    });
    const h = harness(
      [
        plugin('p', {
          onTickExecute: (c) => {
            pluginBudget = c.cpu;
          },
          onTickEnd: () => {
            order.push('tickEnd');
          },
        }),
      ],
      { memory, tasks }
    );
    h.next();
    h.next();
    expect(order).toEqual([
      'begin',
      'tickEnd',
      'persist:2',
      'end',
      'drive:2',
      'begin',
      'tickEnd',
      'persist:3',
      'end',
      'drive:3',
    ]);
    expect(budgets).toEqual([pluginBudget, pluginBudget]);
  });

  it('skips task driving in safe mode ticks', () => {
    const drives: number[] = [];
    let fail = false;
    const h = harness(
      [
        plugin('core', {
          manifest: { id: 'core', version: 1, critical: true },
          onTickExecute: () => {
            if (fail) throw new Error('down');
          },
        }),
      ],
      { tasks: stubTasks({ drive: (tick) => drives.push(tick) }) }
    );
    h.next();
    fail = true;
    h.next();
    expect(h.framework.getStatus().safeMode).toBe(true);
    expect(drives).toEqual([2]);
  });

  it('records a throwing drive as a tasks.drive failure without entering safe mode', () => {
    const ran: number[] = [];
    const h = harness(
      [
        plugin('p', {
          onTickExecute: (c) => {
            ran.push(c.tick);
          },
        }),
      ],
      {
        tasks: stubTasks({
          drive: () => {
            throw new Error('scheduler bug');
          },
        }),
      }
    );
    h.next();
    h.next();
    const status = h.framework.getStatus();
    expect(status.safeMode).toBe(false);
    expect(status.failures).toEqual([
      expect.objectContaining({ pluginId: 'framework', phase: 'tasks.drive' }),
    ]);
    expect(ran).toEqual([2, 3]);
  });

  it('binds context.tasks to the plugin id', () => {
    const h = harness([
      plugin('a', {
        onTickExecute: (c) => {
          c.tasks.submit('job', function* (): Generator<void, void, void> {
            throw new Error('a failed');
          });
        },
      }),
      plugin('b', {
        onTickExecute: (c) => {
          c.tasks.submit('job', function* () {
            return 'b';
          });
        },
      }),
    ]);
    h.next();
    expect(h.runtime.tasks.bind('a').get('job')!.failure!.pluginId).toBe('a');
    expect(h.runtime.tasks.bind('b').get('job')!.result).toBe('b');
  });

  /**
   * 插件释放时回收任务：任务每片把 Game.cpu.getUsed 推进 1，admit() 在达到 limit − reserveCpu
   * （20 − 5）后拒绝，使无尽任务每 tick 只驱动有限片数；每个 tick 开始前把 CPU 计数归零。
   */
  const releaseHarness = (plugins: (burn: () => Generator<void, never, void>) => LeviathanPlugin[]) => {
    let h: ReturnType<typeof harness>;
    let used = 0;
    const counter = { slices: 0 };
    const burn = function* (): Generator<void, never, void> {
      for (;;) {
        counter.slices++;
        h.use(++used);
        yield;
      }
    };
    h = harness(plugins(burn));
    const tick = () => {
      used = 0;
      h.use(0);
      h.next();
    };
    const handle = (owner: string, id: string) =>
      h.runtime.tasks.bind(owner).get(id);
    return { h: () => h, counter, tick, handle };
  };

  it('rejects publishing through plugin contexts while tasks are driven', () => {
    const heard = jest.fn();
    const h = harness([
      plugin('listener', {
        setup: (c) =>
          c.events.subscribe({ scope: 'global' }, 'creep:death', 's', heard),
      }),
      plugin('publisher', {
        onTickExecute: (c) => {
          c.tasks.submit('announce', function* () {
            c.events.publish({ scope: 'global' }, 'creep:death', {
              creepName: 'x',
            });
          });
        },
      }),
    ]);
    h.next();
    const task = h.runtime.tasks.bind('publisher').get('announce')!;
    expect(task.state).toBe('failed');
    expect(task.failure!.message).toContain(
      'Events cannot be published while tasks are driven'
    );
    expect(heard).not.toHaveBeenCalled();
  });

  it('does not deliver raw-bus events to plugins while tasks are driven and warns once', () => {
    const heard = jest.fn();
    const lines: string[] = [];
    const logging = createLogging({
      output: { write: (line) => lines.push(line), notify: () => undefined },
    });
    let h: ReturnType<typeof harness>;
    h = harness(
      [
        plugin('listener', {
          setup: (c) =>
            c.events.subscribe({ scope: 'global' }, 'creep:death', 's', heard),
        }),
        plugin('publisher', {
          onTickExecute: (c) => {
            // 钩子中的正常发布照常投递。
            c.events.publish({ scope: 'global' }, 'creep:death', {
              creepName: 'hook',
            });
            c.tasks.submit('announce:' + c.tick, function* () {
              h.runtime.bus.publish({ scope: 'global' }, 'creep:death', {
                creepName: 'task',
              });
            });
          },
        }),
      ],
      { logging }
    );
    h.next();
    h.next();
    expect(heard.mock.calls.map(([data]) => data.creepName)).toEqual([
      'hook',
      'hook',
    ]);
    expect(
      lines.filter((line) => line.includes('published while tasks are driven'))
    ).toHaveLength(1);
  });

  it('drives tasks only within the regular limit minus reserveCpu, not up to tickLimit', () => {
    const r = releaseHarness((burn) => [
      plugin('p', {
        onTickExecute: (c) => {
          c.tasks.submit('loop', burn);
        },
      }),
    ]);
    r.tick();
    // 桩：limit 20、tickLimit 100、默认 reserveCpu 5；每片 1 CPU，admit() 在 15 之后拒绝。
    expect(r.counter.slices).toBe(15);
  });

  it('releases the tasks of a disabled plugin', () => {
    const r = releaseHarness((burn) => [
      plugin('p', {
        onTickExecute: (c) => {
          c.tasks.submit('loop', burn);
        },
      }),
    ]);
    r.tick();
    const task = r.handle('p', 'loop')!;
    expect(task.state).toBe('running');
    const slices = r.counter.slices;
    expect(slices).toBeGreaterThan(0);
    r.h().framework.disable('p');
    r.tick();
    expect(task.state).toBe('cancelled');
    expect(r.handle('p', 'loop')).toBeUndefined();
    expect(r.counter.slices).toBe(slices);
    expect(r.h().runtime.tasks.getStatus()).toEqual({ queued: 0, running: 0 });
  });

  it('releases the tasks of a circuit-broken plugin', () => {
    const r = releaseHarness((burn) => [
      plugin('p', {
        onTickExecute: (c) => {
          c.tasks.submit('loop', burn);
          throw new Error('broken');
        },
      }),
    ]);
    r.tick();
    r.tick();
    r.tick();
    const task = r.handle('p', 'loop')!;
    expect(task.state).toBe('running');
    r.tick();
    expect(task.state).toBe('cancelled');
    expect(r.handle('p', 'loop')).toBeUndefined();
  });

  it('releases tasks when a plugin instance is replaced or its setup fails', () => {
    let bodyCalls = 0;
    const r = releaseHarness((burn) => {
      const make = () =>
        plugin('p', {
          onTickExecute: (c) => {
            c.tasks.submit('loop', () => {
              bodyCalls++;
              return burn();
            });
          },
        });
      return [
        make(),
        plugin('broken', {
          setup: (c) => {
            c.tasks.submit('boot', burn);
            throw new Error('setup failed');
          },
        }),
      ];
    });
    r.tick();
    const old = r.handle('p', 'loop')!;
    // setup 失败的插件在同一 tick 内被释放，它在 setup 中提交的任务一并回收。
    expect(r.handle('broken', 'boot')).toBeUndefined();
    r.h().framework.unregister('p');
    r.h().framework.register(
      plugin('p', {
        onTickExecute: (c) => {
          c.tasks.submit('loop', () => {
            bodyCalls++;
            return (function* () {
              yield;
            })();
          });
        },
      })
    );
    r.tick();
    expect(old.state).toBe('cancelled');
    const fresh = r.handle('p', 'loop')!;
    expect(fresh).not.toBe(old);
    expect(bodyCalls).toBe(2);
  });
});
