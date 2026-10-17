/**
 * 文件摘要：版本号规则的命令行入口，由 package.json 的 version:bump 与 check:version 调用。
 *
 * 所属位置：scripts/version/，开发工具，不进入游戏构建产物；由 Node 的类型剥离直接运行，不经编译。
 * 用法：
 * - `node scripts/version/cli.ts bump [task|milestone|hotfix]`：按规则写入下一个版本号；
 *   通过 `npm version --no-git-tag-version` 同步更新 package.json 与 package-lock.json，不提交、不打标签。
 * - `node scripts/version/cli.ts check`：校验工作区中的版本号；不符合规则时以非零状态退出。
 * 副作用：读取 Git 状态；bump 会改写 package.json 与 package-lock.json。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  type BumpKind,
  type DependencyFields,
  type Version,
  checkVersion,
  dependencyChanged,
  formatVersion,
  nextVersion,
  parseVersion,
  touchesBuildPaths,
} from './lib.ts';

interface PackageJson extends DependencyFields {
  readonly version: string;
}

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** 读取某个提交中的 package.json；该提交或文件不存在时返回 null。 */
const packageAt = (ref: string): PackageJson | null => {
  try {
    return JSON.parse(git('show', `${ref}:package.json`)) as PackageJson;
  } catch {
    return null;
  }
};

const workingPackage = (): PackageJson => JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;

const isMerging = (): boolean => {
  try {
    git('rev-parse', '-q', '--verify', 'MERGE_HEAD');
    return true;
  } catch {
    return false;
  }
};

const bump = (kind: BumpKind): void => {
  const current = parseVersion(workingPackage().version);
  const others: Version[] = [];
  if (kind === 'hotfix') {
    for (const ref of ['dev', 'master']) {
      const pkg = packageAt(ref);
      if (pkg) {
        others.push(parseVersion(pkg.version));
      }
    }
  }
  const next = formatVersion(nextVersion(kind, current, others));
  execFileSync('npm', ['version', next, '--no-git-tag-version'], { stdio: 'ignore' });
  console.log(`版本号 ${formatVersion(current)} → ${next}（${kind}）`);
};

const check = (): void => {
  const head = packageAt('HEAD');
  if (!head) {
    console.log('仓库尚无提交，跳过版本号校验');
    return;
  }
  const current = workingPackage();
  const changedFiles = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
  const result = checkVersion({
    merging: isMerging(),
    base: parseVersion(head.version),
    current: parseVersion(current.version),
    buildChanged: touchesBuildPaths(changedFiles) || dependencyChanged(head, current),
  });
  console.log(result.message);
  if (!result.ok) {
    process.exitCode = 1;
  }
};

const [command, kindArg] = process.argv.slice(2);
if (command === 'bump') {
  const kind = (kindArg ?? 'task') as BumpKind;
  if (kind !== 'task' && kind !== 'milestone' && kind !== 'hotfix') {
    throw new Error(`未知的 bump 类型：${kind}（应为 task、milestone 或 hotfix）`);
  }
  bump(kind);
} else if (command === 'check') {
  check();
} else {
  throw new Error('用法：cli.ts bump [task|milestone|hotfix] | cli.ts check');
}
