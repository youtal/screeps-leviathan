/**
 * 文件摘要：验证 core/taskScheduler 的生成器驱动、调度与 CPU 准入、实例语义（submit 只保证
 * 实例存在、release、实时句柄、闲置回收、按 owner 释放）、失败隔离与硬终止恢复、bucket 盈余
 * 额度，以及经存储分区记录的跨 global 重启次数。
 *
 * 覆盖边界：只测试 TaskScheduler 自身（直接构造 createTaskScheduler），不经过 Runtime/Framework
 * 组装。Runtime 的装配与上下文绑定见 test/runtime.test.ts 的 “Runtime task scheduler” 用例，
 * Framework 的驱动时机、safeMode 跳过、宿主故障与插件释放时回收任务见 test/framework.test.ts
 * 的 “Framework task driving” 用例，依赖边界见 test/coreDependencyBoundary.test.ts。
 *
 * 测试桩：CpuBudget 只实现 admit() 的次数语义——drive 每开始一片调用一次 admit()，桩在前
 * slices 次返回 true，从而精确控制“本次还能驱动几片”；Game.cpu.getUsed 返回一个由任务体
 * 主动推进的计数，用来模拟分片的 CPU 消耗。盈余额度的用例改用真实的 CpuGovernor 口径。
 * 硬终止用 killing() 包装的 ErrorMapper 模拟：任务抛出 HardKill 时异常穿透错误边界、drive
 * 中途退出，调度器看到的状态（midSlice 保持为真、本片之后的代码没有执行）与真实硬终止相同。
 * global reset 用“丢弃调度器与 MemoryManager、以同一份存储文本新建”模拟，与私服实测一致：
 * drive 前由 MemoryHost.end 写出的存储在硬终止后保留。
 */
import { createTaskScheduler } from '@/core/taskScheduler';
import { createLogging } from '@/core/logger';
import { createErrorMapper } from '@/core/errorMapper';
import { createMemoryManager } from '@/core/memoryManager';
import { createCpuGovernor } from '@/core/framework/cpuGovernor';
import type {
  CpuBudget,
  ErrorMapper,
  MemoryHost,
  Profiler,
  TaskBody,
  TaskContext,
} from '@/contracts';

/** drive 每开始一片调用一次 admit()；前 slices 次返回 true，之后拒绝。 */
const budget = (slices = Infinity): CpuBudget => {
  let calls = 0;
  return { remaining: () => 1e9, admit: () => calls++ < slices };
};

/** 模拟 CPU 硬终止的异常：由 killing() 放行穿过错误边界。 */
class HardKill extends Error {}

/**
 * 包装真实 ErrorMapper：普通异常照常规范化与报告；HardKill 在错误边界返回之后重新抛出，
 * 使 driveOnce 中 next() 之后的代码全部不执行，等价于引擎在分片中途终止脚本。
 */
const killing = (inner: ErrorMapper): ErrorMapper => ({
  ...inner,
  capture: (metadata, callback) => {
    let killed: HardKill | undefined;
    const result = inner.capture(metadata, () => {
      try {
        return callback();
      } catch (error) {
        if (error instanceof HardKill) {
          killed = error;
          return undefined as never;
        }
        throw error;
      }
    });
    if (killed) throw killed;
    return result;
  },
});

/** 构造独立的 TaskHost 与可控 Game 桩；每个用例各自持有互不影响的注册表。 */
const createHost = (
  setup: {
    bucket?: number;
    wrapErrorMapper?: (inner: ErrorMapper) => ErrorMapper;
    profiler?: Profiler | null;
    defaultMaxCpuPerTick?: number;
    retainTicks?: number;
  } = {}
) => {
  // 收集全部日志行：失败任务的 error 日志来自 ErrorMapper 默认出口，用于断言去重行为。
  const lines: string[] = [];
  const logging = createLogging({
    output: { write: (line) => lines.push(line), notify: () => undefined },
  });
  const inner = createErrorMapper(logging, {
    loadSourceMap: () => {
      throw new Error('no map');
    },
  });
  const errorMapper = setup.wrapErrorMapper
    ? setup.wrapErrorMapper(inner)
    : inner;
  const cpu = { bucket: setup.bucket ?? 10000, used: 0, getUsed: () => cpu.used };
  const game = { time: 1, cpu } as unknown as Game;
  const host = createTaskScheduler({
    getGame: () => game,
    logging,
    errorMapper,
    profiler: setup.profiler ?? null,
    defaultMaxCpuPerTick: setup.defaultMaxCpuPerTick,
    retainTicks: setup.retainTicks,
  });
  /**
   * 以当前 Game.time 驱动一次，然后推进到下一个 tick，对应 Framework 每 tick 的收尾。
   * 模拟的硬终止会从 drive 抛出，finally 保证 tick 照常推进——真实引擎中被终止的 tick
   * 之后同样会进入下一个 tick。
   */
  const step = (slices = Infinity) => {
    try {
      host.drive(game.time, budget(slices));
    } finally {
      game.time++;
    }
  };
  return { host, game, cpu, lines, step };
};

/** yield iterations 次后返回固定结果。 */
function* countingTask(iterations: number): Generator<void, string, void> {
  for (let i = 0; i < iterations; i++) yield;
  return 'done:' + iterations;
}

/** 记录执行顺序的任务：每片把 id 推入 trace。 */
const labelled = (trace: string[], id: string, iterations: number) =>
  function* (): Generator<void, string, void> {
    for (let i = 0; i < iterations; i++) {
      trace.push(id);
      yield;
    }
    return id;
  };

/** 永不结束的任务；每片把 onSlice 的副作用执行一次（例如推进 CPU 计数）。 */
const endless =
  (onSlice: () => void = () => undefined) =>
  function* (): Generator<void, never, void> {
    for (;;) {
      onSlice();
      yield;
    }
  };

describe('TaskScheduler 驱动与调度', () => {
  test('跨多次 drive 恢复到中断处，最终给出结果', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    const handle = tasks.submit('t1', () => countingTask(3));
    expect(handle.state).toBe('queued');
    // countingTask(3) 需要 3 次 yield 加 1 次触发 return 的 next()，共 4 片。
    for (let i = 0; i < 3; i++) {
      step(1);
      expect(handle.state).toBe('running');
    }
    step(1);
    expect(handle.state).toBe('done');
    expect(handle.result).toBe('done:3');
  });

  test('id 只需在同一 owner 内唯一，不同 owner 用相同 id 不会互相冲突', () => {
    const { host, step } = createHost();
    const a = host.bind('pluginA');
    const b = host.bind('pluginB');
    a.submit('work', () => countingTask(1));
    b.submit('work', () => countingTask(2));
    step();
    expect(a.get('work')!.result).toBe('done:1');
    expect(b.get('work')!.result).toBe('done:2');
  });

  test('同优先级任务按分片轮转，不会被先提交者永久饿死', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    const trace: string[] = [];
    tasks.submit('a', labelled(trace, 'a', 3));
    tasks.submit('b', labelled(trace, 'b', 3));
    step();
    expect(trace).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  test('高优先级任务先于低优先级任务获得 CPU', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    const trace: string[] = [];
    tasks.submit('low', labelled(trace, 'low', 2), { priority: 0 });
    tasks.submit('high', labelled(trace, 'high', 2), { priority: 10 });
    step();
    expect(trace).toEqual(['high', 'high', 'low', 'low']);
  });

  test('每开始一片前调用 admit()，被拒绝后停止驱动，任务保留在队列中', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    const trace: string[] = [];
    const handle = tasks.submit('long', labelled(trace, 'x', 1000));
    step(0);
    expect(trace).toHaveLength(0);
    expect(handle.state).toBe('queued');
    step(5);
    expect(trace).toHaveLength(5);
    expect(handle.state).toBe('running');
  });

  test('低于任务自身 minBucket 时不驱动，bucket 恢复后正常推进', () => {
    const { host, cpu, step } = createHost({ bucket: 100 });
    const tasks = host.bind('owner');
    const handle = tasks.submit('picky', () => countingTask(1), {
      minBucket: 8000,
    });
    step();
    expect(handle.state).toBe('queued');
    cpu.bucket = 9000;
    step();
    expect(handle.state).toBe('done');
  });

  test('TaskContext 的 tick 与 used 来自当前 tick 与 getUsed 差值，只在恢复前更新', () => {
    const { host, cpu, game, step } = createHost();
    const tasks = host.bind('owner');
    const trace: { tick: number; used: number }[] = [];
    tasks.submit('i', function* (context: TaskContext) {
      for (;;) {
        trace.push({ tick: context.tick, used: context.used });
        cpu.used += 5;
        // 同一分片内部读到的 used 不随消耗变化。
        trace.push({ tick: context.tick, used: context.used });
        yield;
      }
    });
    game.time = 42;
    step(3);
    step(1);
    expect(trace.filter((_, i) => i % 2 === 0)).toEqual([
      { tick: 42, used: 0 },
      { tick: 42, used: 5 },
      { tick: 42, used: 10 },
      // 换到下一个 tick 后本 tick 的累计从 0 重新开始。
      { tick: 43, used: 0 },
    ]);
    expect(trace[1]).toEqual({ tick: 42, used: 0 });
  });

  test('maxCpuPerTick 是软上限：达到后本 tick 不再开始新分片，最多超出一片', () => {
    const { host, cpu, step } = createHost();
    const tasks = host.bind('owner');
    let slices = 0;
    tasks.submit(
      'capped',
      endless(() => {
        slices++;
        cpu.used += 4;
      }),
      { maxCpuPerTick: 10 }
    );
    step();
    // 4、8 仍低于 10，第三片把累计推到 12 后停止：超出量不超过一片。
    expect(slices).toBe(3);
    step();
    expect(slices).toBe(6);
  });

  test('达到上限的任务让出的 CPU 分给其他任务，包括更低优先级的任务', () => {
    const { host, cpu, step } = createHost();
    const tasks = host.bind('owner');
    const trace: string[] = [];
    tasks.submit(
      'high',
      endless(() => {
        trace.push('high');
        cpu.used += 5;
      }),
      { priority: 10, maxCpuPerTick: 5 }
    );
    tasks.submit('low', labelled(trace, 'low', 2), { priority: 0 });
    step(4);
    expect(trace).toEqual(['high', 'low', 'low']);
  });

  test('defaultMaxCpuPerTick 作为缺省上限，任务可以单独覆盖', () => {
    const { host, cpu, step } = createHost({ defaultMaxCpuPerTick: 2 });
    const tasks = host.bind('owner');
    const counts = { byDefault: 0, overridden: 0 };
    tasks.submit(
      'byDefault',
      endless(() => {
        counts.byDefault++;
        cpu.used += 1;
      })
    );
    tasks.submit(
      'overridden',
      endless(() => {
        counts.overridden++;
        cpu.used += 1;
      }),
      { maxCpuPerTick: 4 }
    );
    step();
    expect(counts).toEqual({ byDefault: 2, overridden: 4 });
  });

  test('在 drive 中提交的任务从下一 tick 开始驱动', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    const trace: string[] = [];
    tasks.submit('parent', function* () {
      tasks.submit('child', labelled(trace, 'child', 1));
      trace.push('parent');
    });
    step();
    expect(trace).toEqual(['parent']);
    step();
    expect(trace).toEqual(['parent', 'child']);
  });

  test('label 缺省回退到 id；显式 label 与 owner 组成 Profiler 标签', () => {
    const wrapped: string[] = [];
    const profiler: Profiler = {
      wrap: (label: string, fn: any) => {
        wrapped.push(label);
        return fn;
      },
      enable: () => undefined,
      disable: () => undefined,
      reset: () => undefined,
      report: () => undefined,
    };
    const { host, step } = createHost({ profiler });
    const bound = host.bind('roomOwner');
    bound.submit('layout:W1N1', () => countingTask(0), { label: 'layout' });
    bound.submit('other', () => countingTask(0));
    step();
    expect(wrapped).toEqual(
      expect.arrayContaining(['task.roomOwner.layout', 'task.roomOwner.other'])
    );
    expect(wrapped).not.toContain('task.roomOwner.layout:W1N1');
  });
});

describe('TaskScheduler 实例语义', () => {
  test('同 id 已有活跃实例时 submit 返回同一句柄，body 与 options 不再生效', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    let created = 0;
    const body = () => {
      created++;
      return countingTask(5);
    };
    const first = tasks.submit('t1', body);
    expect(tasks.submit('t1', body, { priority: 99 })).toBe(first);
    step(1);
    expect(tasks.submit('t1', body)).toBe(first);
    expect(created).toBe(1);
    expect(first.state).toBe('running');
  });

  test('每 tick 无条件 submit：done 的结果保持可见，不会被重新计算', () => {
    const { host, step } = createHost();
    const tasks = host.bind('planner');
    let bodyCalls = 0;
    let applied = 0;
    const body: TaskBody<number> = () => {
      bodyCalls++;
      return (function* () {
        yield;
        return 42;
      })();
    };
    for (let t = 0; t < 20; t++) {
      const plan = tasks.submit('layout:W1N1', body, { label: 'layout' });
      if (plan.state === 'done') applied++;
      step();
    }
    expect(bodyCalls).toBe(1);
    expect(applied).toBe(19);
    expect(tasks.get<number>('layout:W1N1')!.result).toBe(42);
  });

  test('每 tick 无条件 submit：确定性失败只执行一次，failed 对调用方可见', () => {
    const { host, step } = createHost();
    const tasks = host.bind('planner');
    let bodyCalls = 0;
    const states = new Set<string>();
    const body: TaskBody<number> = () => {
      bodyCalls++;
      return (function* (): Generator<void, number, void> {
        throw new Error('deterministic');
      })();
    };
    for (let t = 0; t < 10; t++) {
      states.add(tasks.submit('x', body).state);
      step();
    }
    expect(bodyCalls).toBe(1);
    expect([...states]).toEqual(['queued', 'failed']);
    expect(tasks.get('x')!.failure!.message).toContain('deterministic');
  });

  test('每 tick 无条件 submit：过期保持可见，不会被立即重建', () => {
    const { host, step } = createHost();
    const tasks = host.bind('planner');
    let bodyCalls = 0;
    const states: string[] = [];
    const body = () => {
      bodyCalls++;
      return endless()();
    };
    for (let t = 0; t < 6; t++) {
      states.push(tasks.submit('x', body, { deadlineTicks: 3 }).state);
      step(1);
    }
    expect(bodyCalls).toBe(1);
    // tick 1 创建，tick 1–3 各驱动一片，tick 4 的清扫判定过期。
    expect(states).toEqual([
      'queued',
      'running',
      'running',
      'running',
      'expired',
      'expired',
    ]);
  });

  test('deadlineTicks 到期后释放生成器，不再被驱动', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    let resumed = 0;
    const handle = tasks.submit('e', endless(() => resumed++), {
      deadlineTicks: 3,
    });
    step(1);
    step(1);
    step(1);
    expect(resumed).toBe(3);
    step(1);
    expect(handle.state).toBe('expired');
    step(1);
    expect(resumed).toBe(3);
  });

  test('release 释放实例：活跃的先取消，下一次 submit 从 body 重新创建；不存在时是空操作', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    let bodyCalls = 0;
    const body = () => {
      bodyCalls++;
      return countingTask(5);
    };
    const first = tasks.submit('r', body);
    step(1);
    tasks.release('r');
    expect(first.state).toBe('cancelled');
    expect(tasks.get('r')).toBeUndefined();
    const second = tasks.submit('r', body);
    expect(second).not.toBe(first);
    expect(second.state).toBe('queued');
    expect(bodyCalls).toBe(2);
    expect(() => tasks.release('missing')).not.toThrow();
  });

  test('done 的实例 release 后重新提交才会重算', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    let bodyCalls = 0;
    const body = () => {
      bodyCalls++;
      return countingTask(0);
    };
    tasks.submit('d', body);
    step();
    expect(tasks.submit('d', body).state).toBe('done');
    tasks.release('d');
    expect(tasks.submit('d', body).state).toBe('queued');
    expect(bodyCalls).toBe(2);
  });

  test('cancel 停止活跃实例但保留它；对终态实例是空操作', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    let resumed = 0;
    const handle = tasks.submit('c', endless(() => resumed++));
    handle.cancel();
    step();
    expect(resumed).toBe(0);
    expect(tasks.submit('c', endless()).state).toBe('cancelled');

    const done = tasks.submit('d', () => countingTask(0));
    step();
    done.cancel();
    expect(done.state).toBe('done');
  });

  test('句柄是实例的实时视图：保存的句柄随任务推进更新', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    const handle = tasks.submit('x', () => countingTask(1));
    expect(handle.state).toBe('queued');
    step();
    expect(handle.state).toBe('done');
    expect(handle.result).toBe('done:1');
    expect(tasks.get('x')).toBe(handle);
  });

  test('闲置回收：连续 retainTicks 个 tick 未被 submit/get 触碰的实例被释放', () => {
    const { host, step } = createHost({ retainTicks: 3 });
    const tasks = host.bind('owner');
    const idle = tasks.submit('idle', endless());
    const polled = tasks.submit('polled', endless());
    const unread = tasks.submit('unread', () => countingTask(0));
    for (let t = 0; t < 4; t++) {
      tasks.get('polled');
      step(3);
    }
    // 活跃的闲置实例先取消再移除；终态实例直接移除；持续查询的实例保留。
    expect(idle.state).toBe('cancelled');
    expect(tasks.get('idle')).toBeUndefined();
    expect(unread.state).toBe('done');
    expect(tasks.get('unread')).toBeUndefined();
    expect(tasks.get('polled')).toBe(polled);
    expect(polled.state).toBe('running');
  });

  test('releaseOwner 只释放指定 owner 的实例', () => {
    const { host, step } = createHost();
    const a = host.bind('pluginA');
    const b = host.bind('pluginB');
    const running = a.submit('long', endless());
    const finished = a.submit('short', () => countingTask(0));
    const other = b.submit('long', endless());
    step(3);
    host.releaseOwner('pluginA');
    expect(running.state).toBe('cancelled');
    expect(finished.state).toBe('done');
    expect(a.get('long')).toBeUndefined();
    expect(a.get('short')).toBeUndefined();
    expect(b.get('long')).toBe(other);
    expect(host.getStatus()).toEqual({ queued: 0, running: 1 });
  });

  test('getStatus 汇总 queued 与 running 的任务数量', () => {
    const { host, step } = createHost();
    const tasks = host.bind('owner');
    tasks.submit('j1', () => countingTask(5));
    tasks.submit('j2', () => countingTask(5));
    expect(host.getStatus()).toEqual({ queued: 2, running: 0 });
    step(1);
    expect(host.getStatus()).toEqual({ queued: 1, running: 1 });
  });

  test('body 本身抛错时 submit 直接抛出，不登记实例', () => {
    const { host } = createHost();
    const tasks = host.bind('owner');
    expect(() =>
      tasks.submit('broken', () => {
        throw new Error('no room');
      })
    ).toThrow('no room');
    expect(tasks.get('broken')).toBeUndefined();
  });

  test('非法配置在创建时同步抛错', () => {
    const { host } = createHost();
    const tasks = host.bind('owner');
    const body = () => countingTask(0);
    expect(() => tasks.submit('k', body, { priority: NaN })).toThrow();
    expect(() => tasks.submit('k', body, { deadlineTicks: 0 })).toThrow();
    expect(() => tasks.submit('k', body, { minBucket: -1 })).toThrow();
    expect(() => tasks.submit('k', body, { maxCpuPerTick: 0 })).toThrow();
    expect(() => tasks.submit('k', body, { maxCpuPerTick: NaN })).toThrow();
    expect(() => tasks.submit('', body)).toThrow();
    expect(() => host.bind('')).toThrow();
    for (const invalid of [
      { defaultMinBucket: -1 },
      { defaultMaxCpuPerTick: 0 },
      { retainTicks: 0 },
      { retainTicks: NaN },
    ]) {
      expect(() =>
        createTaskScheduler({
          getGame: () => ({ time: 1 }) as Game,
          logging: createLogging(),
          errorMapper: createErrorMapper(createLogging()),
          profiler: null,
          ...invalid,
        })
      ).toThrow();
    }
  });
});

describe('TaskScheduler 失败隔离与硬终止恢复', () => {
  test('生成器异常被隔离为该任务的 failure，归属提交者 owner，不影响其它任务', () => {
    const { host, step } = createHost();
    const a = host.bind('pluginA');
    const b = host.bind('pluginB');
    a.submit('bad', function* (): Generator<void, string, void> {
      yield;
      throw new Error('boom');
    });
    b.submit('good', () => countingTask(1));
    step();
    const failure = a.get('bad')!.failure!;
    expect(a.get('bad')!.state).toBe('failed');
    expect(failure.pluginId).toBe('pluginA');
    expect(failure.phase).toBe('framework');
    expect(failure.message).toContain('boom');
    expect(b.get('good')!.result).toBe('done:1');
  });

  test('确定性失败在同 owner 另有成功分片时也只记录一条 error', () => {
    const { host, lines, step } = createHost();
    const tasks = host.bind('planner');
    tasks.submit('long', endless());
    for (let t = 0; t < 5; t++) {
      tasks.submit('bad', function* (): Generator<void, void, void> {
        throw new Error('deterministic');
      });
      step(3);
    }
    expect(lines.filter((line) => line.includes('deterministic'))).toHaveLength(
      1
    );
  });

  test('同一轮 drive 中被取消的就绪任务保持 cancelled，不会被重新驱动', () => {
    const { host, lines, step } = createHost();
    const tasks = host.bind('owner');
    const victim = tasks.submit('victim', () => countingTask(1));
    tasks.submit(
      'killer',
      function* () {
        victim.cancel();
      },
      { priority: 1 }
    );
    step();
    expect(victim.state).toBe('cancelled');
    expect(victim.failure).toBeUndefined();
    expect(lines.filter((line) => line.includes('TypeError'))).toHaveLength(0);
  });

  test('硬终止后按 body 重启一次；再次被中断即以 failed 结束，其他任务继续', () => {
    const { host, step } = createHost({ wrapErrorMapper: killing });
    const tasks = host.bind('planner');
    let bodyCalls = 0;
    let kills = 0;
    const handle = tasks.submit('heavy', () => {
      bodyCalls++;
      return (function* (): Generator<void, void, void> {
        throw new HardKill('CPU limit');
      })();
    });
    const other = tasks.submit('other', () => countingTask(1), { priority: -1 });
    for (let t = 0; t < 4; t++) {
      try {
        step();
      } catch (error) {
        if (!(error instanceof HardKill)) throw error;
        kills++;
      }
    }
    expect(kills).toBe(2);
    expect(bodyCalls).toBe(2);
    expect(handle.state).toBe('failed');
    expect(handle.failure!.message).toMatch(/interrupted by the hard CPU limit 2 times/);
    expect(other.state).toBe('done');
  });

  test('deadline 先于硬终止恢复判断：被中断的任务到期后过期而不是重启', () => {
    const { host, step } = createHost({ wrapErrorMapper: killing });
    const tasks = host.bind('planner');
    let bodyCalls = 0;
    const handle = tasks.submit(
      'heavy',
      () => {
        bodyCalls++;
        return (function* (): Generator<void, void, void> {
          throw new HardKill('CPU limit');
        })();
      },
      { deadlineTicks: 1 }
    );
    expect(() => step()).toThrow(HardKill);
    step();
    expect(handle.state).toBe('expired');
    expect(bodyCalls).toBe(1);
  });

  test('硬终止后重建任务体时 body 抛错：只让该任务失败，drive 不抛出，其他 owner 继续', () => {
    const { host, step } = createHost({ wrapErrorMapper: killing });
    const a = host.bind('pluginA');
    const b = host.bind('pluginB');
    let calls = 0;
    const fragile = a.submit('fragile', () => {
      if (calls++ > 0) throw new TypeError('room gone');
      return (function* (): Generator<void, void, void> {
        throw new HardKill('CPU limit');
      })();
    });
    const other = b.submit('other', () => countingTask(1), { priority: -1 });
    expect(() => step()).toThrow(HardKill);
    expect(() => step()).not.toThrow();
    expect(fragile.state).toBe('failed');
    expect(fragile.failure!.message).toContain('room gone');
    expect(fragile.failure!.pluginId).toBe('pluginA');
    expect(other.state).toBe('done');
  });
});

describe('TaskScheduler bucket 盈余额度', () => {
  /**
   * 使用真实 CpuGovernor（reserveCpu 5、minBucket 1000）的口径：常规额度为 limit − 5；
   * bucket 达到 burstBucket 时，已用 CPU 可以到 limit + min(盈余, limit)，并与 tickLimit − 5
   * 保持 100 CPU 的距离。任务每片推进 1 CPU，驱动一次后的已用 CPU 就是可用上限。
   */
  const usedAfterDrive = (setup: {
    limit: number;
    tickLimit?: number;
    bucket: number;
    burstBucket?: number;
  }) => {
    const cpu = {
      limit: setup.limit,
      tickLimit: setup.tickLimit ?? 500,
      bucket: setup.bucket,
      used: 0,
      getUsed: () => cpu.used,
    };
    const game = { time: 1, cpu } as unknown as Game;
    const logging = createLogging({ output: { write: () => undefined } });
    const host = createTaskScheduler({
      getGame: () => game,
      logging,
      errorMapper: createErrorMapper(logging),
      profiler: null,
      burstBucket: setup.burstBucket,
    });
    host
      .bind('owner')
      .submit('work', endless(() => cpu.used++), { minBucket: 0 });
    host.drive(1, createCpuGovernor(() => game));
    return cpu.used;
  };

  test('bucket 低于水位时只用常规额度的剩余', () => {
    expect(usedAfterDrive({ limit: 20, bucket: 9000 })).toBe(15);
  });

  test('bucket 达到水位时再用高于水位的盈余，每 tick 至多一份常规额度', () => {
    expect(usedAfterDrive({ limit: 20, bucket: 9510 })).toBe(30);
    expect(usedAfterDrive({ limit: 20, bucket: 10000 })).toBe(40);
  });

  test('盈余额度与 tickLimit 保持 100 CPU 的距离', () => {
    // limit 300 时两倍额度为 600，被 tickLimit 500 − reserveCpu 5 − 100 限制在 395。
    expect(usedAfterDrive({ limit: 300, bucket: 10000 })).toBe(395);
  });

  test('burstBucket 为 Infinity 时关闭盈余额度', () => {
    expect(
      usedAfterDrive({ limit: 20, bucket: 10000, burstBucket: Infinity })
    ).toBe(15);
  });

  test('非法的 burstBucket 在创建时拒绝', () => {
    expect(() =>
      createTaskScheduler({
        getGame: () => ({ time: 1 }) as Game,
        logging: createLogging(),
        errorMapper: createErrorMapper(createLogging()),
        profiler: null,
        burstBucket: NaN,
      })
    ).toThrow('Invalid burst bucket');
  });
});

describe('TaskScheduler 跨 global 重启记录', () => {
  /** 一份跨 global 保留的存储文本，对应 RawMemory。 */
  const createStore = () => {
    const state = { raw: '', tick: 1 };
    return {
      state,
      platform: {
        readRaw: () => state.raw,
        writeRaw: (value: string) => {
          state.raw = value;
        },
        getTick: () => state.tick,
      },
      /** 调度器分区的内容；分区尚未写出时为 undefined。 */
      records: (): Record<string, Record<string, number>> | undefined =>
        state.raw
          ? JSON.parse(state.raw).memoryManager.partitions.framework?.tasks
              ?.payload
          : undefined,
    };
  };

  /**
   * 以同一份存储新建一个 global：MemoryManager 与调度器都是新实例。tick() 按 Framework 的
   * 顺序执行一个 tick：begin → 插件钩子 → persist → end → drive；模拟的硬终止从 drive 抛出，
   * tick 照常推进。
   */
  const createGlobal = (
    store: ReturnType<typeof createStore>,
    setup: { retainTicks?: number; memory?: MemoryHost } = {}
  ) => {
    const lines: string[] = [];
    const logging = createLogging({
      output: { write: (line) => lines.push(line), notify: () => undefined },
    });
    const memory =
      setup.memory ?? createMemoryManager({ logging, platform: store.platform });
    const errorMapper = killing(
      createErrorMapper(logging, {
        loadSourceMap: () => {
          throw new Error('no map');
        },
      })
    );
    const game = { time: store.state.tick, cpu: { bucket: 10000, getUsed: () => 0 } } as unknown as Game;
    const host = createTaskScheduler({
      getGame: () => game,
      logging,
      errorMapper,
      profiler: null,
      memory,
      retainTicks: setup.retainTicks,
    });
    const tasks = host.bind('planner');
    let kills = 0;
    const tick = (hooks: () => void = () => undefined) => {
      game.time = store.state.tick;
      memory.begin(game.time);
      try {
        hooks();
        host.persist(game.time);
        memory.end(game.time);
        host.drive(game.time, budget(3));
      } catch (error) {
        if (!(error instanceof HardKill)) throw error;
        kills++;
      } finally {
        store.state.tick++;
      }
    };
    return { host, tasks, tick, lines, kills: () => kills };
  };

  /** 每次分片都触发硬终止的任务体。 */
  const poison = () =>
    (function* (): Generator<void, void, void> {
      throw new HardKill('CPU limit');
    })();

  test('每次都让 global 重建的任务在第 3 次 reset 后以 failed 结束，记录随之删除', () => {
    const store = createStore();
    let totalKills = 0;
    for (let reset = 0; reset < 3; reset++) {
      const global = createGlobal(store);
      global.tick(() => global.tasks.submit('poison', poison));
      totalKills += global.kills();
      expect(store.records()?.planner?.poison).toBe(reset);
    }
    expect(totalKills).toBe(3);
    const last = createGlobal(store);
    let handle: ReturnType<typeof last.tasks.submit> | undefined;
    last.tick(() => {
      handle = last.tasks.submit('poison', poison);
    });
    expect(last.kills()).toBe(0);
    expect(handle!.state).toBe('failed');
    expect(handle!.failure!.message).toMatch(
      /restarted by 3 global resets without completing/
    );
    expect(store.records()?.planner).toBeUndefined();
  });

  test('正常结束或被 release 的实例删除记录，下一次创建从 0 开始', () => {
    const store = createStore();
    const global = createGlobal(store);
    global.tick(() => global.tasks.submit('job', () => countingTask(0)));
    expect(store.records()?.planner?.job).toBe(0);
    // 结束发生在 drive 中，记录在下一次 persist 删除。
    global.tick();
    expect(store.records()?.planner).toBeUndefined();

    global.tick(() => global.tasks.submit('long', endless()));
    expect(store.records()?.planner?.long).toBe(0);
    global.tick(() => global.tasks.release('long'));
    expect(store.records()?.planner).toBeUndefined();

    // reset 前已经结束的实例不会被计为 reset。
    const next = createGlobal(store);
    let handle: ReturnType<typeof next.tasks.submit> | undefined;
    next.tick(() => {
      handle = next.tasks.submit('job', () => countingTask(0));
    });
    expect(handle!.state).toBe('done');
  });

  test('上一 global 留下且无人认领的记录在 retainTicks 后清理', () => {
    const store = createStore();
    const first = createGlobal(store);
    first.tick(() => first.tasks.submit('orphan', endless()));
    expect(store.records()?.planner?.orphan).toBe(0);
    const second = createGlobal(store, { retainTicks: 3 });
    second.tick(() => second.tasks.submit('other', endless()));
    expect(store.records()?.planner).toEqual({ orphan: 0, other: 0 });
    second.tick(() => second.tasks.get('other'));
    second.tick(() => second.tasks.get('other'));
    second.tick(() => second.tasks.get('other'));
    expect(store.records()?.planner).toEqual({ other: 0 });
  });

  test('登记前已取消的实例不写记录', () => {
    const store = createStore();
    const global = createGlobal(store);
    global.tick(() => global.tasks.submit('quick', endless()).cancel());
    expect(store.records()?.planner).toBeUndefined();
  });

  test('非法的任务 id 只让该记录写入失败，不阻断存储写盘与任务运行', () => {
    const store = createStore();
    const global = createGlobal(store);
    let bad: ReturnType<typeof global.tasks.submit> | undefined;
    global.tick(() => {
      bad = global.tasks.submit('__proto__', () => countingTask(0));
      global.tasks.submit('fine', endless());
    });
    expect(store.records()?.planner).toEqual({ fine: 0 });
    expect(bad!.state).toBe('done');
    expect(
      global.lines.filter((line) => line.includes('task records not persisted'))
    ).toHaveLength(1);
  });

  test('存储不可用时跳过记录并只告警一次，任务照常运行', () => {
    const store = createStore();
    const unavailable: MemoryHost = {
      getStatus: () => ({ loadError: null, rawWriteError: null }),
      begin: () => undefined,
      end: () => undefined,
      bind: () => () => {
        throw new Error('storage load failed');
      },
    };
    const global = createGlobal(store, { memory: unavailable });
    let handle: ReturnType<typeof global.tasks.submit> | undefined;
    global.tick(() => {
      handle = global.tasks.submit('job', () => countingTask(1));
    });
    global.tick(() => global.tasks.submit('other', () => countingTask(0)));
    expect(handle!.state).toBe('done');
    expect(
      global.lines.filter((line) => line.includes('task records not persisted'))
    ).toHaveLength(1);
  });
});
