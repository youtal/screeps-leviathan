/**
 * 文件摘要：部署工具的命令行入口，由 package.json 的 deploy 脚本调用。
 *
 * 所属位置：scripts/deploy/，开发工具，不进入游戏构建产物；由 Node 的类型剥离直接运行，不经编译。
 * 用法见 lib.ts 的 USAGE。除 accounts 外，每条命令都必须用 --account 指定 .secret.json 中的账户。
 * 流程（upload）：校验账户与分支 → 运行 npm run build → 读取 dist/main.js 与 source map →
 * 新建或覆盖目标分支 → 回读校验 → 按 --activate 切换生效分支并确认。
 * 副作用：读取 .secret.json 与 Git 状态；upload 会构建并写入 dist/；除 accounts 外都会访问服务器，
 * upload、activate、rollback 会改变服务器上的代码或生效分支。输出不包含令牌。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { createApi, type ScreepsApi } from './api.ts';
import {
  type DeployArgs,
  activeWorldBranch,
  assertBranchName,
  collectModules,
  describeAccounts,
  mismatchedModules,
  parseDeployArgs,
  planUpload,
  releaseBranchProblem,
  rollbackTarget,
  selectAccount,
  serverOrigin,
  versionBranch,
} from './lib.ts';

const SECRET_FILE = '.secret.json';
const MAIN_FILE = 'dist/main.js';
const MAP_FILE = 'dist/main.js.map';

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();

const readSecret = (): unknown => {
  if (!existsSync(SECRET_FILE)) {
    throw new Error(`未找到 ${SECRET_FILE}；参照 .secret.json.example 创建`);
  }
  try {
    return JSON.parse(readFileSync(SECRET_FILE, 'utf8'));
  } catch {
    throw new Error(`${SECRET_FILE} 不是合法的 JSON`);
  }
};

/** 切换后重新读取分支列表，确认服务器上的生效分支确实已变更。 */
const activateAndConfirm = async (api: ScreepsApi, branch: string): Promise<void> => {
  await api.setActiveWorld(branch);
  const active = activeWorldBranch(await api.listBranches());
  if (active !== branch) {
    throw new Error(`切换后生效分支为 ${active ?? '（无）'}，不是 ${branch}`);
  }
  console.log(`生效分支已切换为 ${branch}`);
};

const listBranches = async (api: ScreepsApi): Promise<void> => {
  for (const { branch, activeWorld, activeSim } of await api.listBranches()) {
    const marks = [activeWorld ? '生效' : '', activeSim ? '模拟' : ''].filter(Boolean).join('、');
    console.log(marks ? `${branch}\t${marks}` : branch);
  }
};

const upload = async (api: ScreepsApi, args: DeployArgs): Promise<void> => {
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  const target = args.branch ?? versionBranch(version);
  assertBranchName(target);
  const problem = releaseBranchProblem({
    branch: target,
    version,
    clean: git('status', '--porcelain') === '',
    headTags: git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean),
  });
  if (problem) {
    throw new Error(problem);
  }

  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  const modules = collectModules(readFileSync(MAIN_FILE, 'utf8'), existsSync(MAP_FILE) ? readFileSync(MAP_FILE, 'utf8') : null);

  const { create } = planUpload(await api.listBranches(), target, args.activate);
  if (create) {
    await api.cloneBranch(target, modules);
  } else {
    await api.uploadCode(target, modules);
  }
  const mismatched = mismatchedModules(modules, await api.getCode(target));
  if (mismatched.length > 0) {
    throw new Error(`回读校验失败，以下模块与本地构建不一致：${mismatched.join('、')}`);
  }
  console.log(`已${create ? '新建' : '覆盖'}分支 ${target} 并通过回读校验（${Object.keys(modules).join('、')}）`);

  if (args.activate) {
    await activateAndConfirm(api, target);
  }
};

const main = async (): Promise<void> => {
  const args = parseDeployArgs(process.argv.slice(2));
  const secret = readSecret();
  if (args.command === 'accounts') {
    for (const line of describeAccounts(secret)) {
      console.log(line);
    }
    return;
  }

  // parseDeployArgs 已保证除 accounts 外都给出了 --account。
  const account = selectAccount(secret, args.account as string);
  const api = createApi(account);
  console.log(`账户 ${account.name}（${serverOrigin(account)}）`);
  switch (args.command) {
    case 'branches':
      await listBranches(api);
      break;
    case 'upload':
      await upload(api, args);
      break;
    case 'activate': {
      const branch = args.branch as string;
      assertBranchName(branch);
      if (!(await api.listBranches()).some((item) => item.branch === branch)) {
        throw new Error(`服务器上没有分支 ${branch}`);
      }
      await activateAndConfirm(api, branch);
      break;
    }
    case 'rollback': {
      const { from, to } = rollbackTarget(await api.listBranches());
      console.log(`回滚：${from} → ${to}`);
      await activateAndConfirm(api, to);
      break;
    }
  }
};

try {
  await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
