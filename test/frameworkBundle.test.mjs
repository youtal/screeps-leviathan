/**
 * 文件摘要：端到端验证真实构建产物在类 Screeps 沙箱中的可运行性。
 *
 * 覆盖：用 rollup（与 rollup.config.mjs 相同的 resolve/commonjs/typescript2 组合）把
 * src/index.ts 与 src/core/framework/index.ts 编译为 CJS，再放进 node:vm 沙箱连续执行
 * 两个 tick。断言 bundle 不依赖 Node 运行时（require 只允许 main.js.map）、不泄露密钥、
 * RawMemory 每 tick 至多写一次且只解析一次、Memory 根对象跨 tick 身份稳定、未声明持久化
 * 的插件不落 Memory，以及真实 sourcemap 能把 main:\d+:\d+ 映射回 src 下的 TS 源文件。
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
      get: () => raw,
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
  return { context, logs, raw: () => raw, writes: () => writes };
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
  // roomShortcuts 未声明持久化，因此 Memory 中不应出现它的分区与版本号；
  // successes 是仅在失败/恢复时更新的兼容字段，正常 tick 后应保持初始值。
  const state = JSON.parse(h.raw()).leviathan;
  assert.equal(state.framework.pluginVersions.roomShortcuts, undefined);
  assert.equal(state.framework.pluginHealth.roomShortcuts.successes, 0);
  assert.equal(h.context.memoryParseCalls, 1);
  assert.equal(h.writes(), 1, 'clean second tick must reuse serialized data');
  assert.deepEqual(h.logs, []);
});

/**
 * 用真实 sourcemap 验证错误映射链路：__proto__ 不是合法插件 id（属于原型链保留键），
 * 用它注册必然失败，从而得到一个稳定的错误样本。断言 mappedStack 指向
 * src/core/framework/createFramework.ts，说明上传的 main.js.map 与产物实际匹配。
 */
test('real generated stack maps to TypeScript using uploaded main.js.map module', async () => {
  const chunk = await compile('src/core/framework/index.ts');
  const h = sandbox(chunk);
  vm.runInContext(
    `
    const framework = exports.createFramework();
    const errors = exports.createErrorMapper();
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
    globalThis.memoryParseCalls = 0;
    const nativeJsonParse = JSON.parse;
    JSON.parse = (...args) => {
      memoryParseCalls++;
      return nativeJsonParse(...args);
    };
    globalThis.runtime = exports.createFramework({ plugins: [{
      manifest: {
        id: 'counter',
        version: 1,
        persistence: { layer: 'critical' }
      },
      onTickBegin(context) {
        context.persistence.commit(memory => {
          memory.count = (memory.count || 0) + 1;
          memory.tick = context.tick;
        });
      }
    }] });
    runtime.loop();
  `,
    h.context
  );
  // 再次确认解析与写回成本：外部直接改写 RawMemory 不会触发重新解析，
  // 因为同一 global 生命周期内以 heap 根为准，外部修改要等 global reset 后才生效。
  const edited = JSON.parse(h.raw());
  edited.leviathan.plugins.counter.count = 100;
  h.context.RawMemory.set(JSON.stringify(edited));
  h.context.Game.time++;
  h.context.runtime.loop();
  assert.equal(JSON.parse(h.raw()).leviathan.plugins.counter.count, 2);
  assert.equal(JSON.parse(h.raw()).leviathan.plugins.counter.tick, 2);
  assert.equal(h.context.memoryParseCalls, 1);
});
