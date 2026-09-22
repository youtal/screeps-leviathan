/**
 * 文件摘要：端到端验证真实构建产物在类 Screeps 沙箱中的可运行性。
 *
 * 覆盖：用 rollup（与 rollup.config.mjs 相同的 resolve/commonjs/typescript2 组合）把
 * src/index.ts 与 src/core/framework/index.ts 编译为 CJS，再放进 node:vm 沙箱连续执行
 * 两个 tick。断言 bundle 不依赖 Node 运行时（require 只允许 main.js.map）、不泄露密钥、
 * 应用装配的 MemoryManager 只在首次 loop 解析一次 RawMemory、干净 tick 不写回、不挂载 Memory，
 * 以及真实 sourcemap 能把 main:\d+:\d+ 映射回 src 下的 TS 源文件。
 *
 * 替代实现：沙箱手工注入 Game/RawMemory/console/require，并用 context.global = context
 * 模拟 Screeps 的全局对象；通过替换沙箱内 JSON.parse 统计解析次数。
 *
 * 前提：会执行真实构建（相对较慢），但不读取 .secret.json、不发起网络请求；由
 * `npm test` 的第三步 `node test/frameworkBundle.test.mjs` 运行（jest 只匹配 *.test.ts）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';

/**
 * 复用与 rollup.config.mjs 相同的插件组合与 tsconfig，确保测的是真实打包产物而不是
 * 单独转译的源码；用 generate 而非 write，避免污染 dist/；finally 关闭 bundle 释放资源。
 */
const compile = async (input) => {
  const bundle = await rollup({
    input,
    plugins: [
      resolve(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        include: ['src/**/*.ts'],
      }),
    ],
  });
  try {
    return (
      await bundle.generate({ format: 'cjs', file: 'main.js', sourcemap: true })
    ).output[0];
  } finally {
    await bundle.close();
  }
};
/**
 * 最小 Screeps 沙箱：
 * - exports 对应游戏内模块导出，loop 从 exports 上取；
 * - RawMemory 用闭包字符串模拟 get/set，并统计写入次数；
 * - require 只实现 main.js.map，模拟游戏内加载产物自带 sourcemap；一旦产物 require 了
 *   任何 Node 内置模块（打包配置失效或误引依赖）都会在这里立即失败；
 * - context.global = context 让产物里的 global/globalThis 指向沙箱自身，而不是宿主 Node。
 */
const sandbox = (chunk) => {
  let raw = '{}';
  let writes = 0;
  let reads = 0;
  const logs = [];
  const context = vm.createContext({
    exports: {},
    console: { log: (value) => logs.push(value) },
    Game: {
      time: 1,
      rooms: {},
      creeps: {},
      powerCreeps: {},
      flags: {},
      getObjectById: () => null,
      notify() {},
      cpu: { getUsed: () => 0, limit: 20, tickLimit: 100, bucket: 10000 },
    },
    RawMemory: {
      get: () => {
        reads++;
        return raw;
      },
      set: (value) => {
        writes++;
        raw = value;
      },
    },
    require: (name) => {
      assert.equal(name, 'main.js.map', 'runtime may only load its source map');
      return JSON.parse(chunk.map.toString());
    },
  });
  context.global = context;
  vm.runInContext(chunk.code, context, { filename: 'main' });
  return {
    context,
    logs,
    raw: () => raw,
    writes: () => writes,
    reads: () => reads,
  };
};

/** 覆盖真实入口的完整 tick：产物必须能连续运行、不输出控制台日志，且干净 tick 不重复序列化。 */
test('actual app bundle executes consecutive ticks without Node runtime dependencies or secrets', async () => {
  const chunk = await compile('src/index.ts');
  const h = sandbox(chunk);
  assert.equal(typeof h.context.exports.loop, 'function');
  // 替换沙箱内的 JSON.parse 统计解析次数：RawMemory 每 tick 只应解析一次，
  // 否则固定 CPU 开销会随 Memory 体积增长。
  vm.runInContext(
    `
    globalThis.memoryParseCalls = 0;
    const nativeJsonParse = JSON.parse;
    JSON.parse = (...args) => {
      memoryParseCalls++;
      return nativeJsonParse(...args);
    };
  `,
    h.context
  );
  h.context.exports.loop();
  // 记录第一 tick 后的 Memory 根引用，用于确认第二个 tick 没有重新解析出新的根对象。
  const memory = h.context.Memory;
  h.context.Game.time++;
  h.context.exports.loop();
  assert.equal(
    h.context.Memory,
    memory,
    'same raw data should reuse heap identity'
  );
  assert.equal(h.context.Memory, undefined, 'app must not mount Memory');
  assert.equal(h.raw(), '{}');
  // MemoryManager 只在首次 begin 解析一次 RawMemory；第二个 tick 复用 heap 根。
  assert.equal(h.context.memoryParseCalls, 1, 'parse raw memory once');
  assert.equal(h.reads(), 1, 'read raw memory once');
  // 当前应用没有持久化分区（RoomShortcuts 不声明持久化），干净 tick 不写回。
  assert.equal(h.writes(), 0, 'clean ticks must not write raw memory');
  assert.deepEqual(h.logs, []);
});

/**
 * 用真实 sourcemap 验证错误映射链路：__proto__ 不是合法插件 id（属于原型链保留键），
 * 用它注册必然失败，从而得到一个稳定的错误样本。断言 mappedStack 指向
 * src/core/framework/createFramework.ts，说明上传的 main.js.map 与产物实际匹配。
 */
test('real generated stack maps to TypeScript using uploaded main.js.map module', async () => {
  const chunk = await compile('src/core/index.ts');
  const h = sandbox(chunk);
  vm.runInContext(
    `
    const noMemory = {
      begin() {}, end() {},
      getStatus() { return { loadError: null, rawWriteError: null }; },
      bind() { return () => { throw new Error('MemoryManager is not assembled'); }; }
    };
    const core = exports.createRuntime({}, { memory: noMemory });
    const framework = exports.createFramework({ runtime: core });
    const errors = core.errorMapper;
    globalThis.failure = errors.capture(
      { tick: 1, pluginId: 'probe', phase: 'setup' },
      () => framework.register({ manifest: { id: '__proto__', version: 1 } })
    );
  `,
    h.context
  );
  assert.equal(h.context.failure.ok, false);
  assert.match(h.context.failure.failure.stack, /main:\d+:\d+/);
  assert.match(
    h.context.failure.failure.mappedStack,
    /src\/core\/framework\/createFramework\.ts:\d+:\d+/
  );
  vm.runInContext(
    `
    globalThis.runs = 0;
    const secondCore = exports.createRuntime({}, { memory: noMemory });
    globalThis.runtime = exports.createFramework({ runtime: secondCore, plugins: [{
      manifest: { id: 'counter', version: 1 },
      onTickBegin(context) {
        if ('persistence' in context) throw new Error('obsolete persistence');
        globalThis.runs++;
      }
    }] });
    runtime.loop();
    Game.time++;
    runtime.loop();
    `,
    h.context
  );
  assert.equal(h.context.runs, 2);
  assert.equal(h.context.runtime.getStatus().safeMode, false);
  assert.equal(h.context.Memory, undefined);
  assert.equal(h.reads(), 0);
  assert.equal(h.writes(), 0);
});

/**
 * 真实产物中的默认 MemoryManager：经 RawMemory 与 Game.time 装配，插件申请分区后按
 * schemaVersion 2 写出；访问器跨 tick 直接使用，干净 tick 不再序列化或写入。
 */
test('bundled memory manager persists partitions and skips clean ticks', async () => {
  const chunk = await compile('src/core/index.ts');
  const h = sandbox(chunk);
  vm.runInContext(
    `
    const core = exports.createRuntime({ profiler: false });
    let accessor;
    globalThis.persisting = exports.createFramework({ runtime: core, plugins: [{
      manifest: { id: 'counter', version: 1 },
      setup(context) {
        accessor = context.memory('main', { version: 1, initialize: () => ({ n: 0 }) });
      },
      onTickExecute() {
        if (Game.time < 3) accessor.commit(['n'], Game.time);
      }
    }] });
    for (let i = 0; i < 4; i++) { persisting.loop(); Game.time++; }
    `,
    h.context
  );
  assert.equal(h.context.persisting.getStatus().safeMode, false);
  assert.deepEqual(JSON.parse(h.raw()), {
    memoryManager: {
      schemaVersion: 2,
      partitions: { counter: { main: { dataVersion: 1, payload: { n: 2 } } } },
    },
  });
  assert.equal(h.reads(), 1, 'raw memory is parsed once per global');
  assert.equal(h.writes(), 2, 'only ticks with commits write');
  assert.equal(h.context.Memory, undefined);
});
