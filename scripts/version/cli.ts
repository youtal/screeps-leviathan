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

/**
 * @description 同步执行一条 git 命令并返回去掉首尾空白的输出。
 * @param args git 子命令及参数。
 * @returns 命令的标准输出。
 * @throws {Error} git 以非零状态退出。
 */
const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();

/**
 * @description 读取某个提交中的 package.json。
 * @param ref 提交、分支或标签名。
 * @returns 解析后的 package.json；该提交或文件不存在时为 null。
 */
const packageAt = (ref: string): PackageJson | null => {
  try {
    return JSON.parse(git('show', `${ref}:package.json`)) as PackageJson;
  } catch {
    return null;
  }
};

/**
 * @description 读取工作区中的 package.json。
 * @returns 解析后的 package.json。
 * @throws {Error} 文件不存在或不是合法 JSON。
 */
const workingPackage = (): PackageJson => JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;

/**
 * @description 判断是否正在完成一次合并（存在 MERGE_HEAD）。
 * @returns 存在 MERGE_HEAD 时为 true。
 */
const isMerging = (): boolean => {
  try {
    git('rev-parse', '-q', '--verify', 'MERGE_HEAD');
    return true;
  } catch {
    return false;
  }
};

/**
 * @description 按规则计算下一个版本号，经 `npm version --no-git-tag-version` 写入 package.json 与 package-lock.json；不提交、不打标签。
 * hotfix 还会读取 dev 与 master 上的版本号，避免与已用过的版本号重名。
 * @param kind 计算方式：task、milestone 或 hotfix。
 * @returns 无返回值；改写两个文件并输出新旧版本号。
 * @throws {Error} 当前版本号格式非法或 npm version 失败。
 */
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

/**
 * @description 校验工作区中的版本号是否符合规则；不符合时把退出码设为 1。
 * @returns 无返回值；结果输出到标准输出。
 * @throws {Error} 版本号格式非法或 git 命令失败。
 */
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
