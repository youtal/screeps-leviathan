/**
 * 文件摘要：以静态扫描强制 Memory 访问边界（AGENTS.md 第 9 节）。
 *
 * 覆盖范围：`src/` 下除 `src/core/memoryManager/` 之外的全部 TypeScript 源文件。
 * 规则：这些文件编译后的代码不得出现 `RawMemory`，也不得直接读写全局 `Memory`
 * （`Memory.x`、`Memory[x]`、`globalThis.Memory`、`Memory =` 等）。需要跨 global
 * 持久状态的模块必须通过 `context.memory` 申请分区，由 MemoryManager 统一提交。
 *
 * 实现方式：先用 TypeScript 的 `transpileModule`（`removeComments: true`）得到去注释的
 * JavaScript，再匹配标识符。这样既能忽略注释里的说明文字（例如"不读写 Memory"），
 * 也能忽略纯类型文件（它们编译后为空），不会因为类型名 `MemoryAccessor` 误报。
 *
 * 运行方式：npm test（ts-jest，testEnvironment=node）；只读源码文件，不执行构建。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const SOURCE_ROOT = join(__dirname, '..', 'src');
/** 唯一允许直接接触游戏持久化存储的模块目录（含其平台适配层）。 */
const ALLOWED_PREFIX = join(SOURCE_ROOT, 'core', 'memoryManager');

/** 递归收集源文件；跳过 `.d.ts`（纯声明，编译结果为空，且不需要走输出生成）。 */
const collectSources = (dir: string): string[] => {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) entries.push(...collectSources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts'))
      entries.push(path);
  }
  return entries;
};

/** 去掉注释后的编译结果：字符串字面量保留（用于发现硬编码的存储访问），类型全部擦除。 */
const compiled = (path: string): string =>
  ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2017,
      module: ts.ModuleKind.CommonJS,
      removeComments: true,
    },
    fileName: path,
  }).outputText;

/** 直接使用存储 API 的几种写法；标识符边界避免误伤 MemoryAccessor/MemoryManager 等名字。 */
const FORBIDDEN: { pattern: RegExp; hint: string }[] = [
  { pattern: /\bRawMemory\b/, hint: 'RawMemory API' },
  { pattern: /\bglobalThis\s*\.\s*Memory\b/, hint: 'globalThis.Memory' },
  { pattern: /(^|[^.\w])Memory\s*\./, hint: 'Memory 字段访问' },
  { pattern: /(^|[^.\w])Memory\s*\[/, hint: 'Memory 下标访问' },
  { pattern: /(^|[^.\w])Memory\s*=(?!=)/, hint: 'Memory 赋值' },
  { pattern: /\bdelete\s+[^;\n]*\bMemory\b/, hint: 'delete Memory' },
];

describe('Memory 访问边界', () => {
  it('keeps every src file outside core/memoryManager free of storage access', () => {
    const violations: string[] = [];
    const sources = collectSources(SOURCE_ROOT).filter(
      (path) => !path.startsWith(ALLOWED_PREFIX)
    );
    expect(sources.length).toBeGreaterThan(0);

    for (const path of sources) {
      const code = compiled(path);
      for (const { pattern, hint } of FORBIDDEN) {
        if (pattern.test(code))
          violations.push(path.slice(SOURCE_ROOT.length + 1) + ' → ' + hint);
      }
    }

    expect(violations).toEqual([]);
  });

  it('detects a violation when a module touches raw storage directly', () => {
    // 自检：把违规片段编译后扫描，确认规则真的能拦住（避免正则写成永远通过）。
    const probe = ts.transpileModule(
      'export const peek = () => RawMemory.get();\nexport const write = () => { Memory.jobs = []; };',
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2017,
          module: ts.ModuleKind.CommonJS,
          removeComments: true,
        },
        fileName: 'probe.ts',
      }
    ).outputText;
    const hits = FORBIDDEN.filter(({ pattern }) => pattern.test(probe));
    expect(hits.map((hit) => hit.hint)).toEqual([
      'RawMemory API',
      'Memory 字段访问',
    ]);
  });
});
