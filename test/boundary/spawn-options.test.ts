/**
 * 文件摘要：KC-04 的 spawnCreep 选项边界回归。
 * 通过真实检查入口验证可选类型不等于实际写入；可证构造放行，明确 memory 拒绝，
 * 动态来源单独诊断。所有源码均为虚拟文件，不执行游戏 API，不进入构建产物。
 */
import { join, resolve } from 'node:path';

import { checkBoundaries, type Violation } from './check';

const root = resolve(__dirname, '../..');
const srcRoot = join(root, 'test', 'boundary', '__spawn_options__', 'src');
const invoke = "spawn.spawnCreep([MOVE], 'n', options);";

const accepted: Record<string, string> = {
  literal: "spawn.spawnCreep([MOVE], 'n', { directions: [TOP] });",
  typedConst: `const options: SpawnOptions = { directions: [TOP] }; ${invoke}`,
  typedLet: `let options: SpawnOptions = { dryRun: true }; ${invoke}`,
  assigned: `let options: SpawnOptions; options = { directions: [TOP] }; ${invoke}`,
  reassigned: `let options: SpawnOptions = { memory: {} }; options = { dryRun: true }; ${invoke}`,
  property: `const options: SpawnOptions = {}; options.dryRun = true; options['directions'] = [TOP]; ${invoke}`,
  wrapped: "const options = (({ directions: [TOP] } satisfies SpawnOptions) as SpawnOptions); " + invoke,
  spread: "const base: SpawnOptions = { directions: [TOP] }; spawn.spawnCreep([MOVE], 'n', { ...base, dryRun: true });",
  afterCall: `const options: SpawnOptions = {}; ${invoke} options.memory = {};`,
  omitted: "spawn.spawnCreep([MOVE], 'n'); spawn.spawnCreep([MOVE], 'n', undefined);",
};

const forbidden: Record<string, string> = {
  literalMemory: "spawn.spawnCreep([MOVE], 'n', { memory: {} });",
  typedMemory: `const options: SpawnOptions = { memory: {} }; ${invoke}`,
  computedMemory: "spawn.spawnCreep([MOVE], 'n', { ['memory']: {} });",
  propertyMemory: `const options: SpawnOptions = {}; options.memory = {}; ${invoke}`,
  elementMemory: `const options: SpawnOptions = {}; options['memory'] = {}; ${invoke}`,
  assignedMemory: `let options: SpawnOptions = {}; options = { memory: {} }; ${invoke}`,
  spreadMemory: "const base: SpawnOptions = { memory: {} }; spawn.spawnCreep([MOVE], 'n', { ...base, dryRun: true });",
  assertedMemory: "spawn.spawnCreep([MOVE], 'n', ({ memory: {} } as Omit<SpawnOptions, 'memory'>));",
};

const dynamic: Record<string, string> = {
  moduleBinding: `const options: SpawnOptions = {}; export { options }; declare const spawn: StructureSpawn; ${invoke}`,
  parameter: "export const run = (spawn: StructureSpawn, options: SpawnOptions): void => { " + invoke + ' };',
  returnValue: "declare const make: () => SpawnOptions; export const run = (spawn: StructureSpawn): void => { const options = make(); " + invoke + ' };',
  omittedType: "export const run = (spawn: StructureSpawn, options: Omit<SpawnOptions, 'memory'>): void => { " + invoke + ' };',
  spread: "export const run = (spawn: StructureSpawn, options: SpawnOptions): void => { spawn.spawnCreep([MOVE], 'n', { ...options }); };",
  computed: "export const run = (spawn: StructureSpawn, key: string): void => { const options: SpawnOptions = { [key]: {} }; " + invoke + ' };',
  escaped: "declare const mutate: (options: SpawnOptions) => void; export const run = (spawn: StructureSpawn): void => { const options: SpawnOptions = {}; mutate(options); " + invoke + ' };',
  alias: `export const run = (spawn: StructureSpawn): void => { const options: SpawnOptions = {}; const alias = options; alias.memory = {}; ${invoke} };`,
  shorthandAlias: `export const run = (spawn: StructureSpawn): void => { const options: SpawnOptions = {}; const wrapper = { options }; wrapper.options.memory = {}; ${invoke} };`,
  shorthandEscape: `declare const mutate: (wrapper: { options: SpawnOptions }) => void; export const run = (spawn: StructureSpawn): void => { const options: SpawnOptions = {}; mutate({ options }); ${invoke} };`,
  conditional: `export const run = (spawn: StructureSpawn, flag: boolean): void => { const options: SpawnOptions = {}; if (flag) options.memory = {}; ${invoke} };`,
  closure: `export const run = (spawn: StructureSpawn): void => { const options: SpawnOptions = {}; const mutate = (): void => { options.memory = {}; }; mutate(); ${invoke} };`,
};

describe('KC-04：按实际构造检查 spawnCreep 选项', () => {
  let violations: Violation[];
  beforeAll(() => {
    const files: Record<string, string> = {};
    for (const [group, cases] of Object.entries({ accepted, forbidden, dynamic })) {
      for (const [name, body] of Object.entries(cases)) {
        files[join(srcRoot, `services/spawnQueue/${group}-${name}.ts`)] = group === 'dynamic'
          ? body
          : `export const run = (spawn: StructureSpawn): void => { ${body} };`;
      }
    }
    files[join(srcRoot, 'kernel/memory/options.ts')] = `export const run = (spawn: StructureSpawn): void => { ${forbidden.literalMemory} };`;
    files[join(srcRoot, 'services/spawnQueue/custom.ts')] = `export const run = (): void => {
      const custom = { spawnCreep: (_body: string[], _name: string, _options: SpawnOptions): void => {} };
      custom.spawnCreep(['move'], 'n', { memory: {} });
    };`;
    violations = checkBoundaries({ root, srcRoot, files });
  });

  // 这里只比较调用处的选项诊断；既有属性规则也可能单独报告 options.memory 写入。
  // 例如调用后的写入不影响本次 spawn 参数，但写入本身仍可能被独立规则拒绝。
  const of = (group: string, name: string): Violation[] =>
    violations.filter((entry) => entry.file === `services/spawnQueue/${group}-${name}.ts` && entry.message.includes('spawnCreep'));

  test.each(Object.keys(accepted))('可证未设置 memory：%s', (name) => {
    expect(of('accepted', name)).toEqual([]);
    if (name !== 'afterCall') {
      expect(violations.filter((entry) => entry.file === `services/spawnQueue/accepted-${name}.ts`)).toEqual([]);
    }
  });

  test.each(Object.keys(forbidden))('实际设置 memory：%s', (name) => {
    expect(of('forbidden', name).map(({ rule, message }) => ({ rule, message }))).toEqual([
      { rule: 'storage', message: '不得使用 spawnCreep 的 memory 选项' },
    ]);
  });

  test.each(Object.keys(dynamic))('无法证明动态来源时明确诊断：%s', (name) => {
    expect(of('dynamic', name).map(({ rule, message }) => ({ rule, message }))).toEqual([
      { rule: 'storage', message: '无法静态确认 spawnCreep 选项未设置 memory；请在调用处使用可检查的对象构造与直接赋值' },
    ]);
  });

  test('存储所有者与同名普通方法保持原检查边界', () => {
    expect(violations.filter(({ file }) => file === 'kernel/memory/options.ts' || file === 'services/spawnQueue/custom.ts')).toEqual([]);
  });
});
