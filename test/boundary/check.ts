/**
 * 文件摘要：依赖边界的静态检查（boundary），检查 src/ 是否遵守架构设计 4.2 的依赖规则。
 *
 * 所属位置：test/boundary/，测试基础设施，不进入游戏构建产物。
 * 输入：项目根目录与 src 下的源文件（可以用虚拟文件覆盖磁盘内容，供规则自测）；
 * 输出：违规列表 {file, line, rule, message}，file 为相对 src 的路径。
 * 实现：用 TypeScript 编译器 API 建立程序并借助类型检查器判定符号来源，不引入额外依赖。
 * 检查的规则：
 * - layer：依赖只能从上往下；除 app 与 main 外，任何层都不得导入 kernel 的实现；
 *   独立入口 src/fallback.ts 不得导入项目模块，包括类型依赖和自身；
 *   使用者设置 src/settings.ts 只能导入 contracts（类型），且只有 app 与 main 可以导入它（架构 4.3）；
 * - package：src 不导入外部包，运行时代码全部打入构建产物；`@/` 是 src/ 的别名（tsconfig.json 的 paths），不算外部包；
 *   构建注入版本号的虚拟模块 `virtual:release`（rollup 内联插件提供）只允许 app/assembly 导入；
 * - alias：跨模块导入必须使用 `@/` 别名，相对路径只用于模块内部（README 开发规范）；
 * - domain：领域之间不互相导入，领域以 domains/<分组>/<领域>/ 为单位；
 * - storage：全局 Memory、RawMemory、InterShardMemory，游戏对象的原生 memory 属性，以及
 *   spawnCreep 的 memory 选项，只能在 kernel 的 memory、segments、intershard 模块中使用；
 * - libState：lib 中不得有模块级可变状态（顶层 let/var，或以 new 创建的顶层对象）。
 * 静态检查的局限：不区分 world 等层导出的是纯函数还是有状态能力；lib 中顶层的对象与数组字面量按常量表处理；
 * "测试不在生产代码中保留隐藏的缺省依赖"无法静态检查，由代码审查保证。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { classifySpawnOptions } from './spawn-options';

export type Rule = 'layer' | 'package' | 'domain' | 'alias' | 'storage' | 'libState';

/** src/ 的导入别名前缀。 */
const ALIAS = '@/';

/** 构建时注入版本号的虚拟模块（docs/design/kernel/bootPort.md 第 6 节），只允许此目录（相对 src，以 / 结尾）导入。 */
const RELEASE_MODULE = 'virtual:release';
const RELEASE_IMPORTER = 'app/assembly/';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
  readonly message: string;
}

/** 源码的层：main、fallback、settings 只对应根目录的同名文件，其余取 src 下的第一级目录。 */
type Layer = 'main' | 'fallback' | 'settings' | 'app' | 'kernel' | 'lib' | 'world' | 'services' | 'colony' | 'domains' | 'contracts';

/** 只对应根目录同名文件的层；同名目录不属于任何层。 */
const ROOT_FILES: ReadonlySet<string> = new Set(['main', 'fallback', 'settings']);

/**
 * 各层允许导入的层：fallback 单独禁止全部项目依赖；settings 只能导入 contracts，除 app 与 main（any）外没有层可以导入它；
 * 其余同层允许，domains 另受 domain 规则约束。
 */
const ALLOWED: Readonly<Record<Layer, readonly Layer[] | 'any'>> = {
  main: 'any',
  fallback: [],
  settings: ['contracts'],
  app: 'any',
  kernel: ['lib', 'contracts'],
  world: ['lib', 'contracts'],
  services: ['world', 'lib', 'contracts'],
  colony: ['world', 'lib', 'contracts'],
  domains: ['services', 'colony', 'world', 'lib', 'contracts'],
  lib: ['contracts'],
  contracts: [],
};

const LAYERS = new Set<string>(Object.keys(ALLOWED));

/** 可以直接访问持久化存储的目录（相对 src，以 / 结尾）。 */
const STORAGE_OWNERS: readonly string[] = ['kernel/memory/', 'kernel/segments/', 'kernel/intershard/'];

const STORAGE_GLOBALS = new Set(['Memory', 'RawMemory', 'InterShardMemory']);

/**
 * @description 把绝对路径换算成相对源码根目录、以 / 分隔的路径。
 * @param srcRoot 源码根目录的绝对路径。
 * @param file 文件的绝对路径。
 * @returns 相对 src 的路径；位于 src 之外时以 .. 开头。
 */
const toSrcPath = (srcRoot: string, file: string): string => relative(srcRoot, file).split(sep).join('/');

/**
 * @description 判定源文件所属的层：根目录只识别 main.ts、fallback.ts 与 settings.ts，其余取 src 下的第一级目录。
 * @param srcPath 相对 src 的路径。
 * @returns 所属层；不在任何已知层中时为 null（包括伪装成目录的 main、fallback、settings）。
 */
const layerOf = (srcPath: string): Layer | null => {
  const rootFile = srcPath.endsWith('.ts') && !srcPath.includes('/') ? srcPath.slice(0, -3) : undefined;
  if (rootFile !== undefined && ROOT_FILES.has(rootFile)) {
    return rootFile as Layer;
  }
  const first = srcPath.split('/')[0];
  return LAYERS.has(first) && !ROOT_FILES.has(first) ? (first as Layer) : null;
};

/**
 * @description 取出文件所属的领域单位 domains/<分组>/<领域>。
 * @param srcPath 相对 src 的路径。
 * @returns 前三级路径；不在领域目录内的文件返回其所在目录。
 */
const domainOf = (srcPath: string): string => srcPath.split('/').slice(0, 3).join('/');

/**
 * @description 取出文件所属的模块，用于判断导入是否跨模块：src 根目录文件各自为一个模块；contracts 整体为一个模块；
 * 领域为 domains/<分组>/<领域>；其余为 <层>/<模块>（层下的单个文件以去掉后缀的文件名为模块）。
 * @param srcPath 相对 src 的路径，可带或不带 .ts 后缀与 /index。
 * @returns 模块标识。
 */
const moduleOf = (srcPath: string): string => {
  const parts = srcPath.replace(/\.ts$/, '').replace(/\/index$/, '').split('/');
  if (parts.length === 1) return parts[0];
  if (parts[0] === 'contracts') return 'contracts';
  return parts.slice(0, parts[0] === 'domains' ? 3 : 2).join('/');
};

/**
 * @description 递归列出目录下的 .ts 源文件（不含 .d.ts）。
 * @param dir 目录的绝对路径。
 * @returns 源文件绝对路径列表；目录不存在时为空数组。
 */
const listSources = (dir: string): string[] => {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...listSources(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
};

/**
 * @description 判断符号是否声明在 @types/screeps 中，用于识别平台提供的全局变量与游戏对象属性。
 * @param symbol 类型检查器解析出的符号。
 * @returns 任一声明位于 @types/screeps 时为 true；符号为空时为 false。
 */
const fromScreepsTypes = (symbol: ts.Symbol | undefined): boolean =>
  (symbol?.declarations ?? []).some((declaration) =>
    declaration.getSourceFile().fileName.split(/[\\/]/).join('/').includes('/@types/screeps/'),
  );

export interface CheckOptions {
  /** 项目根目录，从中读取 tsconfig.json 与依赖类型。 */
  readonly root: string;
  /** 源码根目录，默认 <root>/src。 */
  readonly srcRoot?: string;
  /** 覆盖或补充磁盘内容的虚拟文件：{ [绝对路径]: 文件内容 }。 */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * @description 对 src 下全部源文件（以及虚拟文件）建立 TypeScript 程序，逐文件检查依赖边界规则。
 * @param options 检查选项：项目根目录、源码根目录与虚拟文件。
 * @returns 违规列表；没有违规时为空数组。
 * @throws {Error} 无法读取 tsconfig.json。
 */
export const checkBoundaries = (options: CheckOptions): Violation[] => {
  const root = resolve(options.root);
  const srcRoot = resolve(options.srcRoot ?? join(root, 'src'));
  const virtual = new Map(Object.entries(options.files ?? {}).map(([path, text]) => [resolve(path), text]));
  const rootNames = [...new Set([...listSources(srcRoot), ...[...virtual.keys()].filter((path) => path.startsWith(srcRoot + sep))])];

  const config = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, {
    ...ts.sys,
    /**
     * @description tsconfig.json 无法解析时由编译器调用，转为异常中止检查。
     * @param diagnostic 编译器给出的诊断。
     * @returns 不返回；总是抛出异常。
     * @throws {Error} 诊断消息文本。
     */
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!config) {
    throw new Error('无法读取 tsconfig.json');
  }
  const host = ts.createCompilerHost(config.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (path) => virtual.get(resolve(path)) ?? readFile(path);
  host.fileExists = (path) => virtual.has(resolve(path)) || fileExists(path);
  host.getCurrentDirectory = () => root;
  const program = ts.createProgram({ rootNames, options: config.options, host });
  const checker = program.getTypeChecker();

  const violations: Violation[] = [];

  for (const fileName of rootNames) {
    const source = program.getSourceFile(fileName);
    if (!source) {
      continue;
    }
    const srcPath = toSrcPath(srcRoot, fileName);
    const layer = layerOf(srcPath);
    const storageOwner = STORAGE_OWNERS.some((prefix) => srcPath.startsWith(prefix));
    /**
     * @description 登记一条违规，行号取节点起始位置。
     * @param node 违规所在的语法节点。
     * @param rule 违反的规则。
     * @param message 违规说明。
     * @returns 无返回值；追加到违规列表。
     */
    const report = (node: ts.Node, rule: Rule, message: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push({ file: srcPath, line: line + 1, rule, message });
    };

    if (layer === null) {
      report(source, 'layer', `${srcPath} 不在任何已知的层中`);
      continue;
    }

    /**
     * @description 检查一个导入说明符：外部包、fallback 的任何导入、src 之外的文件、跨层与跨领域导入，以及用相对路径的跨模块导入都登记为违规。
     * @param node 导入所在的语法节点。
     * @param specifier 导入路径文本。
     * @returns 无返回值；违规时登记。
     */
    const checkSpecifier = (node: ts.Node, specifier: string): void => {
      const aliased = specifier.startsWith(ALIAS);
      if (specifier === RELEASE_MODULE && srcPath.startsWith(RELEASE_IMPORTER)) return;
      if (!aliased && !specifier.startsWith('.')) {
        report(node, 'package', `不得导入外部包 ${specifier}`);
        return;
      }
      // 保底入口没有同层例外，类型导入与自导入也会破坏它的独立边界。
      if (layer === 'fallback') {
        report(node, 'layer', `fallback.ts 不得导入项目模块（${specifier}）`);
        return;
      }
      const targetPath = aliased
        ? toSrcPath(srcRoot, resolve(srcRoot, specifier.slice(ALIAS.length)))
        : toSrcPath(srcRoot, resolve(dirname(fileName), specifier));
      if (targetPath.startsWith('..')) {
        report(node, 'layer', `不得导入 src 之外的文件 ${specifier}`);
        return;
      }
      const targetLayer = layerOf(targetPath.endsWith('.ts') ? targetPath : `${targetPath}.ts`) ?? layerOf(targetPath);
      const allowed = ALLOWED[layer];
      if (targetLayer !== layer && allowed !== 'any' && (targetLayer === null || !allowed.includes(targetLayer))) {
        report(node, 'layer', `${layer} 不得导入 ${targetLayer ?? targetPath}（${specifier}）`);
        return;
      }
      if (layer === 'domains' && targetLayer === 'domains' && domainOf(srcPath) !== domainOf(targetPath)) {
        report(node, 'domain', `${domainOf(srcPath)} 不得导入其他领域 ${domainOf(targetPath)}`);
        return;
      }
      if (!aliased && moduleOf(srcPath) !== moduleOf(targetPath)) {
        report(node, 'alias', `跨模块导入须使用 @/ 别名：${specifier}（${moduleOf(srcPath)} → ${moduleOf(targetPath)}）`);
      }
    };

    /**
     * @description 递归遍历语法树：检查各种导入形式，并在非存储模块中检查持久化存储的访问。
     * @param node 当前语法节点。
     * @returns 无返回值；违规时登记。
     */
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(node, node.moduleSpecifier.text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        checkSpecifier(node, node.argument.literal.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0];
        if (specifier && (ts.isStringLiteral(specifier) || (layer === 'fallback' && ts.isStringLiteralLike(specifier)))) {
          checkSpecifier(node, specifier.text);
        } else if (layer === 'fallback') {
          report(node, 'layer', 'fallback.ts 不得动态导入模块');
        }
      } else if (layer === 'fallback' && ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        report(node, 'layer', 'fallback.ts 不得通过 import = 导入模块');
      }

      if (!storageOwner) {
        if (ts.isIdentifier(node) && STORAGE_GLOBALS.has(node.text)) {
          const symbol = checker.getSymbolAtLocation(node);
          if (symbol && symbol.flags & ts.SymbolFlags.Variable && fromScreepsTypes(symbol)) {
            report(node, 'storage', `只有 kernel 的 memory、segments、intershard 模块可以访问 ${node.text}`);
          }
        } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'memory') {
          if (fromScreepsTypes(checker.getSymbolAtLocation(node.name))) {
            report(node, 'storage', '不得读写游戏对象的原生 memory');
          }
        } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'memory') {
          if (fromScreepsTypes(checker.getSymbolAtLocation(node.argumentExpression))) {
            report(node, 'storage', '不得读写游戏对象的原生 memory');
          }
        } else if (ts.isBindingElement(node) && ((node.propertyName ?? node.name) as ts.Node).getText(source) === 'memory') {
          const property = checker.getTypeAtLocation(node.parent).getProperty('memory');
          if (fromScreepsTypes(property)) {
            report(node, 'storage', '不得读写游戏对象的原生 memory');
          }
        } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'spawnCreep') {
          const options = node.arguments[2];
          if (fromScreepsTypes(checker.getSymbolAtLocation(node.expression.name)) && options) {
            // 类型允许 memory 不代表实际设置；构造和赋值无法证明时单独说明静态检查边界。
            const memory = classifySpawnOptions(options, node, checker);
            if (memory === 'present') {
              report(node, 'storage', '不得使用 spawnCreep 的 memory 选项');
            } else if (memory === 'unknown') {
              report(node, 'storage', '无法静态确认 spawnCreep 选项未设置 memory；请在调用处使用可检查的对象构造与直接赋值');
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source);

    if (layer === 'lib') {
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) {
          continue;
        }
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
          report(statement, 'libState', 'lib 不得声明模块级 let/var');
          continue;
        }
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer && ts.isNewExpression(declaration.initializer)) {
            report(declaration, 'libState', 'lib 不得在模块级创建可变对象');
          }
        }
      }
    }
  }

  return violations;
};
