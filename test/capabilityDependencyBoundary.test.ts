/**
 * 文件摘要：静态检查能力层只从 contracts、能力层内部或外部包取得依赖。
 *
 * 扫描 src/capabilities 的 TypeScript import/export 声明，包括类型导入与转发。
 * 能力工厂可经 ModuleContext 使用 Runtime 注入的端口，但不能引用 Core、App 或业务模块
 * 的实现；这样 RoomShortcuts 迁入能力层后不会随业务模块装配方式反向耦合。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

const SOURCE_ROOT = join(__dirname, '..', 'src');
const CAPABILITY_ROOT = join(SOURCE_ROOT, 'capabilities');

const collectSources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? collectSources(path)
      : name.endsWith('.ts')
        ? [path]
        : [];
  });

/** 绝对路径只有落在指定目录内时才被允许；目录本身不是可导入文件。 */
const inside = (root: string, path: string): boolean => {
  const local = relative(root, path);
  return local !== '' && local !== '..' && !local.startsWith('..' + sep);
};

const isAllowed = (source: string, specifier: string): boolean => {
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(source), specifier);
    return (
      inside(CAPABILITY_ROOT, target) ||
      inside(join(SOURCE_ROOT, 'contracts'), target)
    );
  }
  if (specifier.startsWith('@/'))
    return (
      specifier === '@/contracts' ||
      specifier.startsWith('@/contracts/') ||
      specifier.startsWith('@/capabilities/')
    );
  // 任何项目别名都不能绕过层间边界；npm 包等裸模块名不属于源码层。
  return !['@modules/', '@utils/', '@setting/', '@test/'].some((alias) =>
    specifier.startsWith(alias)
  );
};

describe('能力层依赖边界', () => {
  it('does not import Core, App, business modules or utilities directly', () => {
    const violations: string[] = [];
    for (const path of collectSources(CAPABILITY_ROOT)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      for (const statement of source.statements) {
        if (
          (ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          !isAllowed(path, statement.moduleSpecifier.text)
        ) {
          violations.push(
            `${relative(CAPABILITY_ROOT, path)} imports ${statement.moduleSpecifier.text}`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('rejects aliases and relative paths crossing the boundary', () => {
    const source = join(CAPABILITY_ROOT, 'roomShortcuts', 'index.ts');
    expect(isAllowed(source, '@/contracts')).toBe(true);
    expect(isAllowed(source, './createRoomShortcuts')).toBe(true);
    expect(isAllowed(source, '@/modules/goto')).toBe(false);
    expect(isAllowed(source, '../../core/runtime')).toBe(false);
    expect(isAllowed(source, '@modules/goto')).toBe(false);
    expect(isAllowed(source, '@setting/config')).toBe(false);
  });
});
