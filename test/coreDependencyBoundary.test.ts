/**
 * 文件摘要：静态验证 Core 同级模块只能通过 contracts 协作，具体实现仅由 Runtime 组合。
 *
 * 扫描 `src/core/<module>/` 中的 import/export 声明并解析别名与相对路径。同一模块内部
 * 可以自由引用；跨模块具体实现引用一律禁止，唯一例外是 Runtime 可按既定前序集合装配
 * logger、eventBus、memoryManager、profiler 与 errorMapper。`src/core/index.ts` 只是公共
 * 出口聚合，不参与运行时依赖图。测试只读源码，不执行模块。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

const CORE_ROOT = join(__dirname, '..', 'src', 'core');
const RUNTIME_PREDECESSORS = new Set([
  'logger',
  'eventBus',
  'memoryManager',
  'profiler',
  'errorMapper',
]);

const collectSources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? collectSources(path)
      : name.endsWith('.ts')
        ? [path]
        : [];
  });

const coreModuleOfPath = (path: string): string | undefined => {
  const local = relative(CORE_ROOT, path);
  if (local.startsWith('..' + sep) || !local.includes(sep)) return undefined;
  return local.split(sep)[0];
};

const targetModule = (
  sourcePath: string,
  specifier: string
): string | undefined => {
  if (specifier.startsWith('@/core/')) return specifier.slice(7).split('/')[0];
  if (!specifier.startsWith('.')) return undefined;
  return coreModuleOfPath(resolve(dirname(sourcePath), specifier));
};

const dependenciesOf = (path: string): string[] => {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const dependencies: string[] = [];
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      dependencies.push(statement.moduleSpecifier.text);
    }
  }
  return dependencies;
};

const violationFor = (
  sourceModule: string,
  target: string
): string | undefined => {
  if (sourceModule === target) return undefined;
  if (sourceModule === 'runtime' && RUNTIME_PREDECESSORS.has(target))
    return undefined;
  return `${sourceModule} -> ${target}`;
};

describe('Core 同级依赖边界', () => {
  it('allows concrete cross-module imports only in the Runtime composition root', () => {
    const violations: string[] = [];
    for (const path of collectSources(CORE_ROOT)) {
      const sourceModule = coreModuleOfPath(path);
      if (!sourceModule) continue;
      for (const specifier of dependenciesOf(path)) {
        const target = targetModule(path, specifier);
        if (!target) continue;
        const edge = violationFor(sourceModule, target);
        if (edge)
          violations.push(
            `${relative(CORE_ROOT, path)} imports ${specifier} (${edge})`
          );
      }
    }
    expect(violations).toEqual([]);
  });

  it('rejects peer imports and Runtime dependencies on later orchestration', () => {
    expect(violationFor('memoryManager', 'logger')).toBe(
      'memoryManager -> logger'
    );
    expect(violationFor('runtime', 'framework')).toBe('runtime -> framework');
    expect(violationFor('runtime', 'logger')).toBeUndefined();
  });
});
