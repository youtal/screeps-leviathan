import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';

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

test('actual app bundle executes consecutive ticks without Node runtime dependencies or secrets', async () => {
  const chunk = await compile('src/index.ts');
  const h = sandbox(chunk);
  assert.equal(typeof h.context.exports.loop, 'function');
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
  const memory = h.context.Memory;
  h.context.Game.time++;
  h.context.exports.loop();
  assert.equal(
    h.context.Memory,
    memory,
    'same raw data should reuse heap identity'
  );
  const state = JSON.parse(h.raw()).leviathan;
  assert.equal(state.framework.pluginVersions.roomShortcuts, undefined);
  assert.equal(state.framework.pluginHealth.roomShortcuts.successes, 0);
  assert.equal(h.context.memoryParseCalls, 1);
  assert.equal(h.writes(), 1, 'clean second tick must reuse serialized data');
  assert.deepEqual(h.logs, []);
});

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
  const edited = JSON.parse(h.raw());
  edited.leviathan.plugins.counter.count = 100;
  h.context.RawMemory.set(JSON.stringify(edited));
  h.context.Game.time++;
  h.context.runtime.loop();
  assert.equal(JSON.parse(h.raw()).leviathan.plugins.counter.count, 2);
  assert.equal(JSON.parse(h.raw()).leviathan.plugins.counter.tick, 2);
  assert.equal(h.context.memoryParseCalls, 1);
});
