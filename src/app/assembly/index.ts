/**
 * 文件摘要：app.assembly，把 kernel 及其服务与游戏环境装配起来（设计见 docs/design/app/assembly.md）。
 *
 * 所属位置：src/app/assembly/，只被 main.ts 使用。读取 Game、使用者设置（src/settings.ts）与全局 require，
 * 以参数注入 kernel；RawMemory 经 kernel.memory 的 createGamePlatform 与 kernel.segments 的 createGameSegmentsPlatform 绑定，
 * InterShardMemory 由 kernel.intershard 在 globalThis 上检测，本模块不直接访问持久化存储。
 * 版本号来自构建时注入的虚拟模块 virtual:release（rollup 内联插件，docs/design/kernel/bootPort.md 第 6 节）。
 * 控制台命名空间安装在 globalThis 上（kernel.console）；每次装配 kernel 后以 createOps 注册 ops 运维命令，
 * 入口状态的读取函数由 main.ts 传入，供 kernel 不可用时的 ops.status（docs/design/app/ops.md 第 4 节）。
 * 模块清单在 M2 起加入业务模块；boot 由 app.boot 的 createBoot 创建，事实读取、通知与设置在此注入。
 * Memory 身份是本项目固定的常量。
 * 状态：无模块级可变状态；createGameServices 每次调用创建新的服务对象，由入口在 heap 中缓存。
 */
import { createBoot, readGameCounts, readGameFacts } from '@/app/boot';
import { type EntryStatus, createOps } from '@/app/ops';
import type { ModuleDefinition } from '@/contracts/module';
import { RESERVE_MIN, RESERVE_RATIO } from '@/kernel/cpu';
import { createErrorMapper } from '@/kernel/errorMapper';
import { createInterShard } from '@/kernel/intershard';
import { type GamePort, type Kernel, createKernel } from '@/kernel/lifecycle';
import { type LogRoot, type LogSink, createLogRoot } from '@/kernel/logger';
import { createGamePlatform } from '@/kernel/memory';
import { createProfiler } from '@/kernel/profiler';
import { createGameSegmentsPlatform } from '@/kernel/segments';
import { bootSettings, loggerSettings, memorySettings, profilerSettings } from '@/settings';
import { release } from 'virtual:release';

/** 本项目在 Memory 中的命名空间、签名与根 schema。 */
export const MEMORY_IDENTITY = { namespace: 'leviathan', signature: 'leviathan', schema: 1 } as const;

/** 模块清单：业务模块从 M2 开始加入。 */
export const MODULES: readonly ModuleDefinition[] = [];

/** 游戏环境的共享服务：入口与 kernel 共用同一个日志根对象。 */
export interface GameServices {
  readonly game: GamePort;
  readonly logRoot: LogRoot;
}

/**
 * @description 选择日志输出端。官服的 console.log 会把内容整体转成 HTML 实体，彩色前缀会显示为标签原文；
 * console.logUnsafe 原样下发，由客户端渲染。存在 logUnsafe 时用它并允许上色，否则用 console.log 且不上色。
 * 只输出 logger 拼出的行：作用域与正文已在 logger 出口转义，HTML 只来自 logger 自己的前缀。
 * @returns 输出端，以及它能否渲染 HTML。
 */
export const consoleSink = (): { readonly sink: LogSink; readonly html: boolean } => {
  const unsafe = console.logUnsafe;
  if (typeof unsafe === 'function') {
    return {
      /**
       * @description 经 console.logUnsafe 输出一行，内容按 HTML 渲染。
       * @param line logger 拼出的一行，作用域与正文已转义。
       * @returns 无返回值。
       */
      sink: (line) => unsafe.call(console, line),
      html: true,
    };
  }
  return {
    /**
     * @description 经 console.log 输出一行纯文本。
     * @param line logger 拼出的一行。
     * @returns 无返回值。
     */
    sink: (line) => console.log(line),
    html: false,
  };
};

/**
 * @description 创建游戏环境的服务：GamePort、错误映射与日志根对象。不读取持久化存储。
 * @returns 游戏服务。
 */
export const createGameServices = (): GameServices => {
  // 只用于特性检测（available），不读写 InterShardMemory 的内容；无状态，每次调用读取全局。
  const interShard = createInterShard(globalThis);
  const game: GamePort = {
    /**
     * @description 当前 tick。
     * @returns Game.time。
     */
    time: () => Game.time,
    /**
     * @description 本 tick 已用 CPU。
     * @returns Game.cpu.getUsed()。
     */
    cpuUsed: () => Game.cpu.getUsed(),
    /**
     * @description 本 tick 可用的 CPU 上限。
     * @returns Game.cpu.tickLimit。
     */
    tickLimit: () => Game.cpu.tickLimit,
    /**
     * @description 每 tick 的 CPU 额度。
     * @returns Game.cpu.limit。
     */
    limit: () => Game.cpu.limit,
    /**
     * @description 当前 bucket。
     * @returns Game.cpu.bucket。
     */
    bucket: () => Game.cpu.bucket,
    /**
     * @description 身份用的 shard 名（架构 11.3 的 here）：运行环境提供 InterShardMemory 时取 Game.shard.name，否则为 'x'。
     * 私服的 driver 会注入 Game.shard，名称是服务器主机名（附录 A F7），可能含 "-" 且随容器重建变化，不能作为身份。
     * 特性检测复用 kernel.intershard，每次调用时读取，不缓存。
     * @returns shard 名；私服为 'x'。
     */
    shard: () => (interShard.available() ? (Game as { shard?: { name?: string } }).shard?.name ?? 'x' : 'x'),
    /**
     * @description 本 tick 存在的 creep 名称，含孵化中的 creep。
     * @returns 新建的名称集合。
     */
    creepNames: () => new Set(Object.keys(Game.creeps)),
    /**
     * @description 本 tick 存在的 flag 名称。
     * @returns 新建的名称集合。
     */
    flagNames: () => new Set(Object.keys(Game.flags)),
  };
  const errors = createErrorMapper({
    /**
     * @description 加载随代码上传的 source map 模块（main.js.map）；游戏外没有全局 require 时返回 undefined。
     * @returns source map 模块的导出，不可用时为 undefined。
     */
    loadMap: () => (globalThis as { require?: (name: string) => unknown }).require?.('main.js.map'),
    bucket: game.bucket,
    // 收尾预留沿用 kernel.cpu 的常量；errorMapper 也在 kernel 之外（入口、保底）使用，取不到本 tick 的预算 B，
    // 所以以额度 limit 为基数（errorMapper 设计"源码映射"一节）。
    /**
     * @description 本 tick 剩余 CPU 减去收尾预留后的余量；不大于 0 时 errorMapper 不做映射。
     * @returns 余量。
     */
    remaining: () => game.tickLimit() - game.cpuUsed() - Math.max(RESERVE_MIN, game.limit() * RESERVE_RATIO),
  });
  const output = consoleSink();
  const logRoot = createLogRoot({
    sink: output.sink,
    time: game.time,
    /**
     * @description 用 errorMapper 把日志中的异常格式化为文本（堆栈按 source map 映射）。
     * @param error 任意异常值。
     * @returns 格式化后的文本。
     */
    format: (error) => errors.format(error),
    levels: loggerSettings.levels,
    color: output.html && loggerSettings.color,
  });
  return { game, logRoot };
};

/**
 * @description 用游戏服务装配 kernel（模块清单、app.boot、Memory 配置、计时器、版本号、持久化平台端口与控制台目标；
 * Memory 抽查数与实例计时取自使用者设置），
 * 并为它创建 app.ops 的运维命令。
 * @param services 游戏服务。
 * @param entryStatus 入口状态的读取函数（main.ts 提供），供 ops.status 在 kernel 不可用时使用。
 * @returns 新的 kernel 实例；首个 tick 才加载 Memory。
 */
export const assemble = (services: GameServices, entryStatus: () => EntryStatus): Kernel => {
  const memoryLog = services.logRoot.scope('memory');
  const kernel = createKernel({
    modules: MODULES,
    boot: createBoot({
      identity: MEMORY_IDENTITY, release, settings: bootSettings,
      time: services.game.time,
      facts: readGameFacts,
      counts: readGameCounts,
      /**
       * @description 模式变化时发出游戏通知。
       * @param message 纯文本通知。
       * @returns 无返回值。
       */
      notify: (message) => Game.notify(message),
    }),
    memory: { ...MEMORY_IDENTITY, auditUnits: memorySettings.auditUnits,
      platform: createGamePlatform((message) => memoryLog.warn(message)) },
    game: services.game,
    logRoot: services.logRoot,
    profiler: createProfiler({ cpuUsed: services.game.cpuUsed }),
    profileInstances: profilerSettings.instances,
    release,
    segments: createGameSegmentsPlatform(),
    interShard: globalThis,
    console: globalThis,
  });
  createOps({ kernel, logRoot: services.logRoot, entryStatus });
  return kernel;
};
