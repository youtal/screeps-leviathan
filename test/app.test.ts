/**
 * 文件摘要：验证 App 组合根（@/app 与 @/index）的装配与惰性初始化契约。
 *
 * 覆盖模块：src/app/runtime.ts 暴露的 framework 单例、src/index.ts 导出的 loop、
 * app 注册的 roomShortcuts 服务插件。覆盖边界：依赖方声明 requires 后能在 setup
 * 阶段从 services 取得查询服务、MemoryManager 只在首次 loop 解析一次 RawMemory、
 * 没有持久化分区时干净 tick 不写回，且导入与 loop 都不读取或挂载全局 Memory。
 *
 * 替代实现：不加载 Screeps 运行时，改为在 global 上注入最小 Game/Memory/RawMemory
 * 桩；RawMemory 用闭包字符串模拟「get 返回上次 set 内容」的语义，使写回次数可断言。
 * beforeEach 调用 jest.resetModules() 再 require，让每个用例都重新执行 app 层模块
 * 初始化，避免 framework 单例与 Memory 访问缓存跨用例泄漏。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；不需要 .secret.json，
 * 不执行真实构建与上传。
 */
describe('App composition', () => {
  beforeEach(() => {
    // 先复位模块注册表，用例内的 require('@/app') 才会重新建单例，
    // 否则上一个用例的 framework 会带着旧的 Game/Memory 引用继续运行。
    jest.resetModules();
    // 最小 Game 桩：只提供 app 启动路径会触及的集合与 CPU 字段；
    // Game.time 由用例自增来模拟 tick 推进。
    (global as any).Game = {
      time: 1,
      rooms: {},
      flags: {},
      creeps: {},
      powerCreeps: {},
      getObjectById: jest.fn(),
      notify: jest.fn(),
      cpu: { getUsed: () => 0, limit: 20, tickLimit: 100, bucket: 10000 },
    };
    (global as any).Memory = {};
    // 用闭包变量保存「磁盘上的 JSON」：get 返回上次 set 的内容，
    // 框架的脏检查与序列化时机因此能通过 set 的调用次数观察到。
    let raw = '{}';
    (global as any).RawMemory = {
      get: jest.fn(() => raw),
      set: jest.fn((value: string) => {
        raw = value;
      }),
    };
  });

  /**
   * 服务插件的创建推迟到首次 loop：必须先注册一个声明 requires 的消费者插件，
   * 才能确认 roomShortcuts 已在 setup 阶段完成注册，而不是只停留在 manifest 中。
   */
  it('exports the instance loop and initializes RoomShortcuts as a service', () => {
    const { framework } = require('@/app');
    const { loop } = require('@/index');
    const { RoomShortcutsService } = require('@/modules/roomShortcuts');
    expect(loop).toBe(framework.loop);
    let service: any;
    framework.register({
      manifest: { id: 'consumer', version: 1, requires: ['roomShortcuts'] },
      setup: (context: any) => {
        service = context.services.get(RoomShortcutsService);
      },
    });
    loop();
    expect(framework.getStatus().safeMode).toBe(false);
    expect(typeof service.getSpawn).toBe('function');
    expect(typeof service.getStorage).toBe('function');
    // 首次 loop 解析一次 RawMemory；没有持久化分区（RoomShortcuts 不声明持久化），
    // 因此不产生任何写回。
    expect((global as any).RawMemory.get).toHaveBeenCalledTimes(1);
    expect((global as any).RawMemory.set).not.toHaveBeenCalled();
    // 第二个 tick 复用 heap 根，不再读取；干净 tick 也不写回。
    Game.time++;
    loop();
    expect((global as any).RawMemory.get).toHaveBeenCalledTimes(1);
    expect((global as any).RawMemory.set).not.toHaveBeenCalled();
  });

  /**
   * 用访问器属性整体替换 global.Memory：任何读取都会抛错，因此模块导入期若发生
   * 急切读取就会被本用例捕获。finally 恢复为普通数据属性，避免污染后续用例。
   */
  it('does not access Memory during module import or loop', () => {
    const get = jest.fn(() => {
      throw new Error('eager Memory');
    });
    Object.defineProperty(global, 'Memory', { configurable: true, get });
    try {
      expect(() => {
        const app = require('@/app');
        app.framework.loop();
      }).not.toThrow();
      expect(get).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(global, 'Memory', {
        configurable: true,
        writable: true,
        value: {},
      });
    }
  });
});
