/**
 * 文件摘要：部署工具（scripts/deploy/lib.ts 与 api.ts）的单元测试。
 * 覆盖参数解析、账户选择与校验（含令牌不外泄）、分支名与版本分支规则、模块表整理、
 * 上传规划、回滚目标选择，以及 API 客户端的请求形状与失败处理（fetch 以假实现替换，不访问网络）。
 */
import { createApi } from '../../scripts/deploy/api';
import {
  type Branch,
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
} from '../../scripts/deploy/lib';

const TOKEN = 'secret-token-value';

const secret = {
  main: { token: TOKEN, protocol: 'https', hostname: 'screeps.com', port: 443, path: '/', branch: 'default' },
  local: { token: TOKEN, protocol: 'http', hostname: 'localhost', port: 21025, path: '/' },
  broken: { token: TOKEN, protocol: 'ftp', hostname: 'x', port: 1, path: '/' },
};

describe('parseDeployArgs', () => {
  test('解析 upload 的账户、分支与 --activate', () => {
    expect(parseDeployArgs(['upload', '--account', 'main', '--branch', 'test', '--activate'])).toEqual({
      command: 'upload',
      account: 'main',
      branch: 'test',
      activate: true,
    });
  });
  test('访问服务器的命令必须指定账户，不设默认账户', () => {
    expect(() => parseDeployArgs(['upload'])).toThrow('--account');
    expect(() => parseDeployArgs(['branches'])).toThrow('--account');
    expect(parseDeployArgs(['accounts']).command).toBe('accounts');
  });
  test('拒绝未知命令、未知选项与不适用的选项', () => {
    expect(() => parseDeployArgs(['push', '--account', 'main'])).toThrow('用法');
    expect(() => parseDeployArgs(['upload', '--account', 'main', '--force'])).toThrow();
    expect(() => parseDeployArgs(['activate', '--account', 'main'])).toThrow('--branch');
    expect(() => parseDeployArgs(['rollback', '--account', 'main', '--activate'])).toThrow('--activate');
    expect(() => parseDeployArgs(['rollback', '--account', 'main', '--branch', 'x'])).toThrow('--branch');
  });
});

describe('账户选择', () => {
  test('取出指定账户，忽略条目中的其他字段', () => {
    const account = selectAccount(secret, 'main');
    expect(account).toEqual({ name: 'main', token: TOKEN, protocol: 'https', hostname: 'screeps.com', port: 443, path: '/' });
    expect(serverOrigin(account)).toBe('https://screeps.com:443');
  });
  test('未知账户报错并列出已有账户', () => {
    expect(() => selectAccount(secret, 'nobody')).toThrow('main、local、broken');
  });
  test('只校验被选中的账户；无效账户的错误消息不包含令牌', () => {
    expect(() => selectAccount(secret, 'local')).not.toThrow();
    expect(() => selectAccount(secret, 'broken')).toThrow('protocol');
    const lines = describeAccounts(secret);
    expect(lines).toEqual(['main\thttps://screeps.com:443', 'local\thttp://localhost:21025', expect.stringContaining('protocol')]);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
  test('path 带前缀时拼入服务器地址', () => {
    const account = selectAccount({ s: { token: TOKEN, protocol: 'https', hostname: 'h', port: 443, path: '/season/' } }, 's');
    expect(serverOrigin(account)).toBe('https://h:443/season');
  });
});

describe('分支规则', () => {
  test('分支名只接受安全字符，排除 $ 开头的生效分支别名', () => {
    expect(() => assertBranchName('v0.1.2')).not.toThrow();
    expect(() => assertBranchName('$activeWorld')).toThrow();
    expect(() => assertBranchName('a b')).toThrow();
    expect(() => assertBranchName('x'.repeat(31))).toThrow();
  });
  const ok = { branch: 'v0.1.2', version: '0.1.2', clean: true, headTags: ['v0.1.2'] };
  test('版本分支只能由干净工作区中带同名标签的发布提交上传', () => {
    expect(releaseBranchProblem(ok)).toBeNull();
    expect(releaseBranchProblem({ ...ok, clean: false })).toContain('未提交');
    expect(releaseBranchProblem({ ...ok, headTags: [] })).toContain('标签');
    expect(releaseBranchProblem({ ...ok, branch: 'v0.1.1' })).toContain('不符');
  });
  test('非版本分支不受发布条件限制', () => {
    expect(releaseBranchProblem({ branch: 'test', version: '0.1.2', clean: false, headTags: [] })).toBeNull();
  });
});

describe('collectModules', () => {
  test('source map 去掉 sourcesContent 并包装为 CommonJS 模块', () => {
    const map = JSON.stringify({ version: 3, sources: ['../src/main.ts'], sourcesContent: ['src'], mappings: 'AAAA' });
    const modules = collectModules('code', map);
    expect(modules.main).toBe('code');
    expect(modules['main.js.map']).toBe('module.exports = {"version":3,"sources":["../src/main.ts"],"mappings":"AAAA"};');
  });
  test('没有 source map 时只上传 main', () => {
    expect(collectModules('code', null)).toEqual({ main: 'code' });
  });
  test('回读校验列出缺失或不一致的模块', () => {
    expect(mismatchedModules({ main: 'a', map: 'b' }, { main: 'a', map: 'c' })).toEqual(['map']);
    expect(mismatchedModules({ main: 'a' }, {})).toEqual(['main']);
  });
});

const branches: Branch[] = [
  { branch: 'default' },
  { branch: 'v0.1.0' },
  { branch: 'v0.1.10' },
  { branch: 'v0.1.9' },
  { branch: 'v0.1.11', activeWorld: true },
  { branch: 'v0.2.0' },
];

describe('planUpload', () => {
  test('分支不存在时新建，存在时覆盖', () => {
    expect(planUpload(branches, 'v0.3.0', false)).toEqual({ create: true });
    expect(planUpload(branches, 'v0.1.0', false)).toEqual({ create: false });
  });
  test('覆盖生效分支必须同时要求切换生效分支', () => {
    expect(() => planUpload(branches, 'v0.1.11', false)).toThrow('--activate');
    expect(planUpload(branches, 'v0.1.11', true)).toEqual({ create: false });
  });
});

describe('rollbackTarget', () => {
  test('按版本号而不是字符串顺序选出上一个版本分支', () => {
    expect(rollbackTarget(branches)).toEqual({ from: 'v0.1.11', to: 'v0.1.10' });
  });
  test('生效分支不是版本分支或没有更早版本时报错', () => {
    expect(() => rollbackTarget([{ branch: 'default', activeWorld: true }])).toThrow('activate');
    expect(() => rollbackTarget([{ branch: 'v0.1.0', activeWorld: true }])).toThrow('没有早于');
  });
});

describe('createApi', () => {
  const account = selectAccount(secret, 'main');
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (body: unknown, status = 200): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  beforeEach(() => {
    calls.length = 0;
  });

  test('令牌只出现在 X-Token 请求头中', async () => {
    const api = createApi(account, fakeFetch({ ok: 1, list: [{ branch: 'default', activeWorld: true, modules: {} }] }));
    expect(await api.listBranches()).toEqual([{ branch: 'default', activeWorld: true, activeSim: undefined }]);
    expect(calls[0].url).toBe('https://screeps.com/api/user/branches');
    expect((calls[0].init.headers as Record<string, string>)['X-Token']).toBe(TOKEN);
    expect(calls[0].url).not.toContain(TOKEN);
  });
  test('上传、新建分支与切换生效分支的请求体', async () => {
    const api = createApi(account, fakeFetch({ ok: 1 }));
    await api.uploadCode('test', { main: 'x' });
    await api.cloneBranch('v0.1.2', { main: 'x' });
    await api.setActiveWorld('v0.1.2');
    const bodies = calls.map(({ init }) => JSON.parse(init.body as string) as Record<string, unknown>);
    expect(calls.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      'POST https://screeps.com/api/user/code',
      'POST https://screeps.com/api/user/clone-branch',
      'POST https://screeps.com/api/user/set-active-branch',
    ]);
    expect(bodies[0]).toMatchObject({ branch: 'test', modules: { main: 'x' } });
    expect(bodies[1]).toEqual({ branch: '', newName: 'v0.1.2', defaultModules: { main: 'x' } });
    expect(bodies[2]).toEqual({ branch: 'v0.1.2', activeName: 'activeWorld' });
  });
  test('读取分支代码时以查询参数指定分支', async () => {
    const api = createApi(account, fakeFetch({ ok: 1, branch: 'test', modules: { main: 'x' } }));
    expect(await api.getCode('test')).toEqual({ main: 'x' });
    expect(calls[0].url).toBe('https://screeps.com/api/user/code?branch=test');
  });
  test('服务器报错、HTTP 失败与非 JSON 响应都抛错，消息不含令牌', async () => {
    await expect(createApi(account, fakeFetch({ error: 'too many branches' })).cloneBranch('b', {})).rejects.toThrow(
      'too many branches',
    );
    await expect(createApi(account, fakeFetch({ ok: 1 }, 500)).setActiveWorld('b')).rejects.toThrow('HTTP 500');
    const textFetch = (async () => new Response('<html>', { status: 502 })) as typeof fetch;
    const failure = createApi(account, textFetch).listBranches();
    await expect(failure).rejects.toThrow('不是 JSON');
    await expect(failure).rejects.not.toThrow(TOKEN);
  });
  test('超时转为明确的错误', async () => {
    const hang = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    await expect(createApi(account, hang, 10).listBranches()).rejects.toThrow('超过 10 ms');
  });
});
