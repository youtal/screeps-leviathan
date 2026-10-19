/**
 * 文件摘要：部署工具的纯函数实现，供 cli.ts 与单元测试使用。
 *
 * 所属位置：scripts/deploy/，开发工具，不进入游戏构建产物。
 * 主要能力：解析命令行参数；从 .secret.json 的内容中取出并校验指定账户；校验代码分支名；
 * 判定版本分支的上传条件；把构建产物整理成 Screeps 模块表；规划上传动作；选出回滚目标。
 * 本文件不读写文件、不调用 Git、不发起网络请求，所有输入由调用方提供。
 * 账户令牌只在 Account.token 中传递，本文件生成的任何消息都不包含令牌。
 */
import { parseArgs } from 'node:util';

import { compareVersion, parseVersion, type Version } from '../version/lib.ts';

/** 一个部署账户：.secret.json 中以账户名为键的一项。 */
export interface Account {
  readonly name: string;
  readonly token: string;
  readonly protocol: 'http' | 'https';
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
}

/** 部署命令。 */
export type Command = 'accounts' | 'branches' | 'upload' | 'activate' | 'rollback';

/** 解析后的命令行参数。 */
export interface DeployArgs {
  readonly command: Command;
  readonly account?: string;
  readonly branch?: string;
  readonly activate: boolean;
}

/** 服务器上的一个代码分支；activeWorld 为 true 表示它是世界中正在运行的分支。 */
export interface Branch {
  readonly branch: string;
  readonly activeWorld?: boolean;
  readonly activeSim?: boolean;
}

/** 上传给服务器的模块表：模块名到模块源码。 */
export type Modules = Readonly<Record<string, string>>;

export const USAGE = [
  '用法：npm run deploy -- <命令> [选项]',
  '  accounts                                         列出 .secret.json 中的账户（不显示令牌）',
  '  branches --account <名称>                        列出该账户的代码分支与生效分支',
  '  upload   --account <名称> [--branch <分支>] [--activate]',
  '                                                   构建并上传；默认分支为 v<版本号>，--activate 上传后切换生效分支',
  '  activate --account <名称> --branch <分支>        把生效分支切换到指定分支',
  '  rollback --account <名称>                        把生效分支切回上一个版本分支',
].join('\n');

const COMMANDS: readonly Command[] = ['accounts', 'branches', 'upload', 'activate', 'rollback'];

/**
 * @description 解析命令行参数并检查各命令的必需项。
 * 所有访问服务器的命令都必须显式给出 --account，不设默认账户，避免把代码上传到错误的账户。
 * @param argv 去掉 node 与脚本路径后的命令行参数。
 * @returns 命令、账户、分支与 --activate 标志。
 * @throws {Error} 命令未知、出现未知选项，或某命令缺少必需项、带了不适用的选项；未知命令时消息为用法说明。
 * @example parseDeployArgs(['upload', '--account', 'main', '--branch', 'test'])
 */
export const parseDeployArgs = (argv: readonly string[]): DeployArgs => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      account: { type: 'string' },
      branch: { type: 'string' },
      activate: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  if (!COMMANDS.includes(command as Command) || rest.length > 0) {
    throw new Error(USAGE);
  }
  const args: DeployArgs = {
    command: command as Command,
    account: values.account,
    branch: values.branch,
    activate: values.activate,
  };
  if (args.command !== 'accounts' && args.account === undefined) {
    throw new Error(`${args.command} 必须用 --account 指定账户`);
  }
  if (args.command === 'activate' && args.branch === undefined) {
    throw new Error('activate 必须用 --branch 指定分支');
  }
  if ((args.command === 'accounts' || args.command === 'branches' || args.command === 'rollback') && args.branch !== undefined) {
    throw new Error(`${args.command} 不接受 --branch`);
  }
  if (args.command !== 'upload' && args.activate) {
    throw new Error('--activate 只用于 upload');
  }
  return args;
};

/**
 * @description 判断值是否为非 null、非数组的对象。
 * @param value 待判断的值。
 * @returns 是对象时为 true，并收窄类型。
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @description 校验一个账户条目的字段形状。
 * @param entry .secret.json 中某个账户名对应的值。
 * @returns 第一个不合格字段的说明（不包含字段的值，避免泄露令牌）；全部合格时为 null。
 */
const accountProblem = (entry: unknown): string | null => {
  if (!isRecord(entry)) {
    return '条目应为对象';
  }
  if (typeof entry.token !== 'string' || entry.token.length === 0) {
    return 'token 应为非空字符串';
  }
  if (entry.protocol !== 'http' && entry.protocol !== 'https') {
    return 'protocol 应为 http 或 https';
  }
  if (typeof entry.hostname !== 'string' || entry.hostname.length === 0) {
    return 'hostname 应为非空字符串';
  }
  if (!Number.isInteger(entry.port) || (entry.port as number) < 1 || (entry.port as number) > 65535) {
    return 'port 应为 1–65535 的整数';
  }
  if (typeof entry.path !== 'string' || !entry.path.startsWith('/')) {
    return 'path 应为以 / 开头的字符串';
  }
  return null;
};

/**
 * @description 列出 .secret.json 中的账户名，不校验各条目。
 * @param secret 解析后的 .secret.json 内容。
 * @returns 账户名列表。
 * @throws {Error} 内容不是以账户名为键的对象。
 */
export const accountNames = (secret: unknown): string[] => {
  if (!isRecord(secret)) {
    throw new Error('.secret.json 的顶层应为以账户名为键的对象');
  }
  return Object.keys(secret);
};

/**
 * @description 从 .secret.json 的内容中取出并校验指定账户。
 * 只校验被选中的账户，其他账户的填写错误不影响本次操作。条目中的其他字段（例如 branch）被忽略：
 * 上传分支由命令行与版本号决定。
 * @param secret 解析后的 .secret.json 内容。
 * @param name 账户名。
 * @returns 校验后的账户。
 * @throws {Error} 账户不存在（消息列出已有账户名）或配置无效（消息不包含字段值）。
 */
export const selectAccount = (secret: unknown, name: string): Account => {
  const names = accountNames(secret);
  if (!names.includes(name)) {
    throw new Error(`.secret.json 中没有账户 ${name}；已有账户：${names.join('、') || '（无）'}`);
  }
  const entry = (secret as Record<string, unknown>)[name];
  const problem = accountProblem(entry);
  if (problem) {
    throw new Error(`账户 ${name} 的配置无效：${problem}`);
  }
  const { token, protocol, hostname, port, path } = entry as Record<string, unknown>;
  return {
    name,
    token: token as string,
    protocol: protocol as Account['protocol'],
    hostname: hostname as string,
    port: port as number,
    path: path as string,
  };
};

/**
 * @description 拼出账户所在服务器的地址，用于提示与 API 拼接；path 为 '/' 时不加前缀。
 * @param account 已校验的账户。
 * @returns 形如 `https://screeps.com:443` 的地址，不包含令牌。
 */
export const serverOrigin = (account: Account): string => {
  const base = account.path === '/' ? '' : account.path.replace(/\/$/, '');
  return `${account.protocol}://${account.hostname}:${account.port}${base}`;
};

/**
 * @description 列出全部账户及其服务器，供 accounts 命令显示。配置无效的账户标出原因，不中断列举。
 * @param secret 解析后的 .secret.json 内容。
 * @returns 每个账户一行，形如 `名称\t服务器地址` 或 `名称\t无效原因`，不包含令牌。
 * @throws {Error} 内容不是以账户名为键的对象。
 */
export const describeAccounts = (secret: unknown): string[] =>
  accountNames(secret).map((name) => {
    try {
      return `${name}\t${serverOrigin(selectAccount(secret, name))}`;
    } catch (error) {
      return `${name}\t${(error as Error).message}`;
    }
  });

/**
 * 分支名规则：字母或数字开头，只含字母、数字、`.`、`_`、`-`，最长 30 个字符。
 * 服务器以 `$` 开头的分支名表示"当前生效分支"的别名，此规则同时排除了这种写法。
 */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;

/** 版本分支的名称形式：v<a.b.c>。 */
const VERSION_BRANCH_PATTERN = /^v(\d+\.\d+\.\d+)$/;

/**
 * @description 按分支名规则校验分支名。
 * @param branch 待校验的分支名。
 * @returns 无返回值；正常结束表示合法。
 * @throws {Error} 分支名不符合规则。
 */
export const assertBranchName = (branch: string): void => {
  if (!BRANCH_PATTERN.test(branch)) {
    throw new Error(`分支名无效：${branch}（字母或数字开头，只含字母、数字、.、_、-，最长 30 个字符）`);
  }
};

/**
 * @description 由版本号得到版本分支名。
 * @param version a.b.c 形式的版本号。
 * @returns 形如 `v0.1.2` 的分支名。
 */
export const versionBranch = (version: string): string => `v${version}`;

/**
 * @description 识别版本分支并取出其版本号。
 * @param branch 分支名。
 * @returns 版本分支的版本号；不是版本分支时为 null。
 */
export const branchVersion = (branch: string): Version | null => {
  const match = VERSION_BRANCH_PATTERN.exec(branch);
  return match ? parseVersion(match[1]) : null;
};

/**
 * @description 判定能否上传到版本分支。版本分支是回滚的依据，其内容必须与该版本的发布提交一致，因此要求：
 * 分支名等于当前 package.json 的版本对应的分支名、工作区干净、HEAD 上有同名标签（发布提交）。
 * 非版本分支不受限制。
 * @param input 判定依据。
 * @param input.branch 目标分支名。
 * @param input.version 当前 package.json 的版本号。
 * @param input.clean 工作区是否没有未提交的改动。
 * @param input.headTags HEAD 上的标签列表。
 * @returns 不满足的原因；满足条件或不是版本分支时为 null。
 */
export const releaseBranchProblem = (input: {
  readonly branch: string;
  readonly version: string;
  readonly clean: boolean;
  readonly headTags: readonly string[];
}): string | null => {
  const { branch, version, clean, headTags } = input;
  if (branchVersion(branch) === null) {
    return null;
  }
  const expected = versionBranch(version);
  if (branch !== expected) {
    return `版本分支 ${branch} 与当前版本号 ${version} 不符；版本分支只能由对应版本的发布提交上传`;
  }
  if (!clean) {
    return `工作区有未提交的改动，不能上传版本分支 ${branch}；调试请用 --branch 指定非版本分支`;
  }
  if (!headTags.includes(expected)) {
    return `HEAD 不是带 ${expected} 标签的发布提交，不能上传版本分支 ${branch}；调试请用 --branch 指定非版本分支`;
  }
  return null;
};

/**
 * @description 把 source map 包装成游戏内可 require 的 CommonJS 模块，并去掉 sourcesContent：
 * 错误映射只需要 mappings 与 sources，源码全文只会增大模块体积，也不应随部署外传。
 * @param mapText source map 的 JSON 文本。
 * @returns `module.exports = {...};` 形式的模块源码。
 * @throws {SyntaxError} mapText 不是合法 JSON。
 */
export const sourceMapModule = (mapText: string): string => {
  const map = JSON.parse(mapText) as Record<string, unknown>;
  delete map.sourcesContent;
  return `module.exports = ${JSON.stringify(map)};`;
};

/**
 * @description 由构建产物 dist/main.js 及其 source map 组成上传的模块表。
 * @param mainCode dist/main.js 的内容。
 * @param mapText source map 文本；没有 source map 时为 null，只上传 main。
 * @returns 模块名到模块源码的映射。
 * @throws {SyntaxError} mapText 不是合法 JSON。
 */
export const collectModules = (mainCode: string, mapText: string | null): Modules =>
  mapText === null ? { main: mainCode } : { main: mainCode, 'main.js.map': sourceMapModule(mapText) };

/**
 * @description 找出当前生效（activeWorld）的分支。
 * @param branches 服务器返回的分支列表。
 * @returns 生效分支名；服务器未标记生效分支时为 null。
 */
export const activeWorldBranch = (branches: readonly Branch[]): string | null =>
  branches.find((branch) => branch.activeWorld === true)?.branch ?? null;

/**
 * @description 规划一次上传：目标分支已存在时覆盖其代码，否则新建分支。
 * 覆盖生效分支会立即改变线上运行的代码，因此只在调用方同时要求切换生效分支（--activate）时允许。
 * @param branches 服务器返回的分支列表。
 * @param target 目标分支名。
 * @param activate 是否在上传后切换生效分支。
 * @returns create 为 true 表示新建分支，false 表示覆盖已有分支。
 * @throws {Error} 目标是生效分支且未给出 --activate。
 */
export const planUpload = (
  branches: readonly Branch[],
  target: string,
  activate: boolean,
): { readonly create: boolean } => {
  if (!activate && activeWorldBranch(branches) === target) {
    throw new Error(`${target} 是当前生效分支，覆盖它会立即改变线上代码；确需如此请加 --activate`);
  }
  return { create: !branches.some((branch) => branch.branch === target) };
};

/**
 * @description 选出回滚目标：版本号低于当前生效版本分支的版本分支中，版本号最高的一个（按版本号而不是字符串排序）。
 * @param branches 服务器返回的分支列表。
 * @returns 当前生效分支 from 与回滚目标 to。
 * @throws {Error} 当前生效分支不是版本分支，或没有更早的版本分支；此时应用 activate 显式指定分支。
 */
export const rollbackTarget = (branches: readonly Branch[]): { readonly from: string; readonly to: string } => {
  const active = activeWorldBranch(branches);
  const activeVersion = active === null ? null : branchVersion(active);
  if (active === null || activeVersion === null) {
    throw new Error(`当前生效分支 ${active ?? '（无）'} 不是版本分支，无法自动选择回滚目标；请用 activate 指定分支`);
  }
  let best: { branch: string; version: Version } | null = null;
  for (const { branch } of branches) {
    const version = branchVersion(branch);
    if (version && compareVersion(version, activeVersion) < 0 && (!best || compareVersion(version, best.version) > 0)) {
      best = { branch, version };
    }
  }
  if (!best) {
    throw new Error(`没有早于 ${active} 的版本分支可供回滚`);
  }
  return { from: active, to: best.branch };
};

/**
 * @description 回读校验：比较本地模块表与服务器上的模块。
 * @param expected 本地上传的模块表。
 * @param actual 服务器返回的模块表。
 * @returns 服务器上缺失或内容不一致的模块名；全部一致时为空数组。
 */
export const mismatchedModules = (expected: Modules, actual: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(expected).filter((name) => actual[name] !== expected[name]);
