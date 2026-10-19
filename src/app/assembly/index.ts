/**
 * 文件摘要：app.assembly，把 kernel 及其服务与游戏环境装配起来（设计见 docs/design/kernel/README.md 第 7 节）。
 *
 * 所属位置：src/app/assembly/，只被 main.ts 使用。读取 Game、使用者设置（src/settings.ts）与全局 require，
 * 以参数注入 kernel；RawMemory 经 kernel.memory 的 createGamePlatform 绑定，本模块不直接访问持久化存储。
 * 第 2 步的临时内容：模块清单为空；临时 boot 只发布 AMBIGUOUS/medium，不执行任何不可逆操作，也不初始化 Memory，
 * 在 M1 第 6 步由 app.boot 替换。Memory 身份常量暂存于此，app.config 建立后迁入。
 * 状态：无模块级可变状态；createGameServices 每次调用创建新的服务对象，由入口在 heap 中缓存。
 */
import type { BootDefinition } from '@/contracts/boot';
import type { ModuleDefinition } from '@/contracts/module';
import { createErrorMapper } from '@/kernel/errorMapper';
import { type GamePort, type Kernel, createKernel } from '@/kernel/lifecycle';
import { type LogRoot, type LogSink, createLogRoot } from '@/kernel/logger';
import { createGamePlatform } from '@/kernel/memory';
import { createProfiler } from '@/kernel/profiler';
import { loggerSettings } from '@/settings';

/** 本项目在 Memory 中的命名空间、签名与根 schema。 */
export const MEMORY_IDENTITY = { namespace: 'leviathan', signature: 'leviathan', schema: 1 } as const;

/** 模块清单：第 2 步为空，业务模块从 M2 开始加入。 */
export const MODULES: readonly ModuleDefinition[] = [];

/** 临时 boot：每个 global 只发布一次 AMBIGUOUS/medium；不执行不可逆操作，不初始化 Memory。 */
export const PROVISIONAL_BOOT: BootDefinition = {
  /**
   * @description 取得 boot 钩子。
   * @param ctx boot 上下文。
   * @returns 含 boot 钩子的对象。
   */
  setup(ctx) {
    let published = false;
    return {
      /**
       * @description 首次调用时发布 AMBIGUOUS/medium，之后什么也不做。
       * @returns 无返回值。
       */
      boot() {
        if (published) return;
        ctx.setMode({ mode: 'AMBIGUOUS', strength: 'medium', since: Game.time });
        published = true;
      },
    };
  },
};

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
    loadMap: () => (globalThis as { require?: (name: string) => unknown }).require?.('main.js.map'),
    bucket: game.bucket,
    remaining: () => game.tickLimit() - game.cpuUsed() - Math.max(2, game.limit() * 0.1),
  });
  const output = consoleSink();
  const logRoot = createLogRoot({
    sink: output.sink,
    time: game.time,
    format: (error) => errors.format(error),
    levels: loggerSettings.levels,
    color: output.html && loggerSettings.color,
  });
  return { game, logRoot };
};

/**
 * @description 用游戏服务装配 kernel：模块清单、临时 boot、Memory 配置与计时器。
 * @param services 游戏服务。
 * @returns 新的 kernel 实例；首个 tick 才加载 Memory。
 */
export const assemble = (services: GameServices): Kernel => {
  const memoryLog = services.logRoot.scope('memory');
  return createKernel({
    modules: MODULES,
    boot: PROVISIONAL_BOOT,
    memory: { ...MEMORY_IDENTITY, platform: createGamePlatform((message) => memoryLog.warn(message)) },
    game: services.game,
    logRoot: services.logRoot,
    profiler: createProfiler({ cpuUsed: services.game.cpuUsed }),
  });
};
