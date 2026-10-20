/**
 * 文件摘要：依赖边界测试。对真实的 src/ 运行边界检查并要求没有违规；
 * 另用一组虚拟源文件逐条构造违规与合规写法，确认检查本身能发现违规且不误报。
 */
import { join, resolve } from 'node:path';

import { type Violation, checkBoundaries } from './check';

const root = resolve(__dirname, '../..');

test('src/ 遵守依赖边界', () => {
  expect(checkBoundaries({ root })).toEqual([]);
});

describe('边界检查规则', () => {
  // 虚拟源码根目录：不在磁盘上存在，只通过 files 提供内容。
  const srcRoot = join(root, 'test', 'boundary', '__virtual__', 'src');
  const files: Record<string, string> = {
    'contracts/memory.ts': 'export interface Store { readonly memory: number }',
    'kernel/memory/index.ts': 'export const raw = (): string => RawMemory.get();\nexport const mem = (): unknown => Memory;',
    'kernel/process/index.ts': "import { raw } from '@/kernel/memory/index';\nexport const run = (): string => raw();",
    'lib/hash.ts': 'export const hash = (text: string): number => text.length;\nexport const TABLE = { a: 1 } as const;',
    'lib/value.ts': "import type { Store } from '@/contracts/memory';\nexport const value = (store: Store): number => store.memory;",
    'lib/dependencies.ts': [
      "import { run } from '@/kernel/process/index';",
      "import { x } from '@/world/roomCache/index';",
      "import { m } from '@/services/movement/index';",
      "import { s } from '@/colony/stage/index';",
      "import { mine } from '@/domains/economy/mining/index';",
      "import { all } from '@/app/assembly/index';",
    ].join('\n'),
    'lib/state.ts': 'let counter = 0;\nexport const cache = new Map<string, number>();\nexport const next = (): number => ++counter;',
    'world/roomCache/index.ts': "import { run } from '@/kernel/process/index';\nexport const x = run;",
    'services/movement/index.ts': "import { hash } from '@/lib/hash';\nimport type { Store } from '@/contracts/memory';\nexport const m = (s: Store): number => hash('a') + s.memory;",
    'colony/stage/index.ts': "import { m } from '@/services/movement/index';\nexport const s = m;",
    'domains/economy/mining/index.ts': "import { m } from '@/services/movement/index';\nexport const mine = m;",
    'domains/economy/mining/plan.ts': "import { mine } from './index';\nexport const plan = mine;",
    'domains/economy/upgrade/index.ts': "import { plan } from '@/domains/economy/mining/plan';\nexport const up = plan;",
    'app/assembly/index.ts': "import { run } from '@/kernel/process/index';\nimport { up } from '@/domains/economy/upgrade/index';\nexport const all = [run, up];",
    'app/boot/index.ts': "import lodash from 'lodash';\nexport const l = lodash;",
    'domains/economy/build/index.ts': [
      'export const f = (creep: Creep, spawn: StructureSpawn, room: Room): void => {',
      '  creep.memory.role = 1;',
      "  const r = room['memory'];",
      '  const { memory } = creep;',
      "  spawn.spawnCreep([MOVE], 'n', { memory: { role: 'x' } });",
      "  spawn.spawnCreep([MOVE], 'n', { directions: [TOP] });",
      '  RawMemory.segments[1] = String(r) + String(memory);',
      '  const ctx = { memory: 1 };',
      '  ctx.memory += 1;',
      '};',
    ].join('\n'),
    'helper.ts': 'export const loose = 1;',
    'fallback/index.ts': 'export const misplaced = (): void => {};',
    'fallback.ts': [
      'export const run = (creep: Creep): void => {',
      '  Game.cpu.getUsed();',
      '  PathFinder.search(creep.pos, { pos: creep.pos, range: 1 });',
      '  creep.move(TOP);',
      '};',
    ].join('\n'),
    'main.ts': "import { run } from '@/fallback';\nexport const loop = run;",
  };

  let violations: Violation[];
  beforeAll(() => {
    violations = checkBoundaries({
      root,
      srcRoot,
      files: Object.fromEntries(Object.entries(files).map(([path, text]) => [join(srcRoot, path), text])),
    });
  });

  const of = (file: string): string[] => violations.filter((v) => v.file === file).map((v) => `${v.rule}:${v.line}`);

  test('合规写法不报错：同层、向下、经 contracts 的类型、kernel 内部访问存储、lib 的常量表', () => {
    for (const file of ['contracts/memory.ts', 'kernel/memory/index.ts', 'kernel/process/index.ts', 'lib/hash.ts', 'services/movement/index.ts', 'domains/economy/mining/index.ts', 'domains/economy/mining/plan.ts', 'app/assembly/index.ts']) {
      expect([file, of(file)]).toEqual([file, []]);
    }
  });

  test('layer：除 app 与 main 外不得导入 kernel；不得向上或横向跨层导入', () => {
    expect(of('world/roomCache/index.ts')).toEqual(['layer:1']);
    expect(of('colony/stage/index.ts')).toEqual(['layer:1']);
  });

  test('KC-02：lib 可导入 contracts 类型，仍禁止导入有状态层', () => {
    expect(of('lib/value.ts')).toEqual([]);
    expect(of('lib/dependencies.ts')).toEqual(['layer:1', 'layer:2', 'layer:3', 'layer:4', 'layer:5', 'layer:6']);
  });

  test('KC-03：只有根目录 fallback.ts 是独立入口，可使用游戏 API 并由 main 导入', () => {
    expect(of('fallback.ts')).toEqual([]);
    expect(of('main.ts')).toEqual([]);
    expect(of('fallback/index.ts')).toEqual(['layer:1']);
  });

  test('settings.ts：只能导入 contracts，只有 app 与 main 可以导入它；同名目录不属于任何层', () => {
    const check = (extra: Record<string, string>) => checkBoundaries({
      root, srcRoot,
      files: Object.fromEntries(Object.entries({
        'contracts/log.ts': "export type LogLevel = 'debug' | 'info';",
        'kernel/logger/index.ts': 'export const createLogRoot = (): number => 1;',
        ...extra,
      }).map(([path, text]) => [join(srcRoot, path), text])),
    });
    const ok = check({
      'settings.ts': "import type { LogLevel } from '@/contracts/log';\nexport const levels: Record<LogLevel, boolean> = { debug: false, info: true };",
      'app/assembly/index.ts': "import { levels } from '@/settings';\nexport const assembled = levels;",
      'main.ts': "import { levels } from '@/settings';\nexport const loop = (): unknown => levels;",
      'kernel/process/index.ts': "import { levels } from '@/settings';\nexport const run = levels;",
      'settings/index.ts': 'export const misplaced = 1;',
    });
    const at = (file: string) => ok.filter((v) => v.file === file).map((v) => `${v.rule}:${v.line}`);
    expect([at('settings.ts'), at('app/assembly/index.ts'), at('main.ts')]).toEqual([[], [], []]);
    expect(at('kernel/process/index.ts')).toEqual(['layer:1']);
    expect(at('settings/index.ts')).toEqual(['layer:1']);
    const bad = check({ 'settings.ts': "import { createLogRoot } from '@/kernel/logger/index';\nexport const x = createLogRoot;" });
    expect(bad.filter((v) => v.file === 'settings.ts').map((v) => `${v.rule}:${v.line}`)).toEqual(['layer:1']);
  });

  test('package：构建注入的 virtual:release 只允许 app/assembly 导入', () => {
    const result = checkBoundaries({
      root, srcRoot,
      files: Object.fromEntries(Object.entries({
        'app/assembly/index.ts': "import { release } from 'virtual:release';\nexport const r = release;",
        'kernel/process/index.ts': "import { release } from 'virtual:release';\nexport const r = release;",
        'main.ts': "import { release } from 'virtual:release';\nexport const loop = (): string => release;",
        'app/boot/index.ts': "import { other } from 'virtual:other';\nexport const o = other;",
      }).map(([path, text]) => [join(srcRoot, path), text])),
    });
    const at = (file: string) => result.filter((v) => v.file === file).map((v) => `${v.rule}:${v.line}`);
    expect(at('app/assembly/index.ts')).toEqual([]);
    expect([at('kernel/process/index.ts'), at('main.ts'), at('app/boot/index.ts')]).toEqual([['package:1'], ['package:1'], ['package:1']]);
  });

  test('alias：跨模块导入必须使用 @/ 别名，相对路径只用于模块内部', () => {
    const result = checkBoundaries({
      root, srcRoot,
      files: Object.fromEntries(Object.entries({
        'contracts/memory.ts': "import type { Json } from './json';\nexport type Store = Json;",
        'contracts/json.ts': 'export type Json = number;',
        'kernel/memory/index.ts': "import { json } from './json';\nimport type { Store } from '@/contracts/memory';\nexport const raw = (s: Store): number => json + s;",
        'kernel/memory/json.ts': 'export const json = 1;',
        'kernel/process/index.ts': "import { raw } from '../memory/index';\nimport type { Store } from '../../contracts/memory';\nexport const run = (s: Store): number => raw(s);",
        'lib/hash.ts': "import type { Json } from '../contracts/json';\nexport const hash = (j: Json): number => j;",
        'fallback.ts': 'export const run = (): void => {};',
        'main.ts': "import { run } from './fallback';\nexport const loop = run;",
        'app/assembly/index.ts': "import { raw } from '@/kernel/memory';\nexport const all = raw;",
      }).map(([path, text]) => [join(srcRoot, path), text])),
    });
    const at = (file: string) => result.filter((v) => v.file === file).map((v) => `${v.rule}:${v.line}`);
    expect([at('contracts/memory.ts'), at('kernel/memory/index.ts'), at('app/assembly/index.ts')]).toEqual([[], [], []]);
    expect(at('kernel/process/index.ts')).toEqual(['alias:1', 'alias:2']);
    expect(at('lib/hash.ts')).toEqual(['alias:1']);
    expect(at('main.ts')).toEqual(['alias:1']);
  });

  test('KC-03：fallback 禁止项目依赖（包括自身、类型、重导出和动态导入）及持久化', () => {
    const fallback = [
      "import { hash } from './lib/hash';",
      "import type { Store } from './contracts/memory';",
      "export { hash as exportedHash } from './lib/hash';",
      "export type Imported = import('./contracts/memory').Store;",
      "void import('./lib/hash');",
      "import { run as self } from './fallback';",
      "const path = './lib/hash'; void import(path);",
      'void import(`./lib/hash`);',
      "import imported = require('./lib/hash');",
      'export const run = (creep: Creep, spawn: StructureSpawn): void => {',
      '  void Memory.creeps;',
      '  RawMemory.set("{}");',
      '  InterShardMemory.setLocal("{}");',
      '  void creep.memory;',
      '  creep["memory"].role = "fallback";',
      '  const { memory } = creep;',
      '  spawn.spawnCreep([MOVE], "fallback", { memory: {} });',
      '};',
    ].join('\n');
    const result = checkBoundaries({
      root,
      srcRoot,
      files: Object.fromEntries(Object.entries({ ...files, 'fallback.ts': fallback }).map(([path, text]) => [join(srcRoot, path), text])),
    });
    expect(result.filter((v) => v.file === 'fallback.ts').map((v) => `${v.rule}:${v.line}`)).toEqual([
      'layer:1', 'layer:2', 'layer:3', 'layer:4', 'layer:5', 'layer:6', 'layer:7', 'layer:8', 'layer:9',
      'storage:11', 'storage:12', 'storage:13', 'storage:14', 'storage:15', 'storage:16', 'storage:17',
    ]);
  });

  test('domain：领域之间不得互相导入，同一领域内部可以', () => {
    expect(of('domains/economy/upgrade/index.ts')).toEqual(['domain:1']);
  });

  test('package：src 不得导入外部包', () => {
    expect(of('app/boot/index.ts')).toEqual(['package:1']);
  });

  test('storage：存储全局变量、原生 memory（点号、下标、解构）与 spawnCreep 的 memory 选项', () => {
    expect(of('domains/economy/build/index.ts')).toEqual(['storage:2', 'storage:3', 'storage:4', 'storage:5', 'storage:7']);
  });

  test('libState：lib 不得有模块级 let/var 或以 new 创建的模块级对象', () => {
    expect(of('lib/state.ts')).toEqual(['libState:1', 'libState:2']);
  });

  test('不在任何层中的文件', () => {
    expect(of('helper.ts')).toEqual(['layer:1']);
  });
});
