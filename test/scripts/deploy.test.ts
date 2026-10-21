/**
 * 文件摘要：部署工具（scripts/deploy/lib.ts 与 api.ts）的单元测试。
 * 覆盖参数解析、账户选择与校验（含令牌不外泄）、分支名与版本分支规则、模块表整理、
 * 上传规划、按本机切换历史选择回滚目标（审计 PA-13）、分支删除的前置检查（PA-20），
 * 以及 API 客户端的请求形状与失败处理，含 inspector 使用的 Memory 与 segment 只读请求（fetch 以假实现替换，不访问网络）。
 */
import { createApi } from '../../scripts/deploy/api';
import {
  type Activation,
  type Branch,
  HISTORY_LIMIT,
  accountHistory,
  activeStack,
  appendActivation,
  assertBranchName,
  collectModules,
  deleteBranchProblem,
  describeAccounts,
  historyKey,
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
  test('delete 必须指定账户与分支', () => {
    expect(parseDeployArgs(['delete', '--account', 'main', '--branch', 'v0.1.0'])).toEqual({
      command: 'delete', account: 'main', branch: 'v0.1.0', activate: false,
    });
    expect(() => parseDeployArgs(['delete', '--account', 'main'])).toThrow('--branch');
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

/**
 * @description 构造一条切换记录。
 * @param from 切换前的生效分支。
 * @param to 切换后的生效分支。
 * @param rollback 是否为回滚。
 * @returns 切换记录。
 */
const switched = (from: string | null, to: string, rollback = false): Activation => ({ time: '2026-10-20T00:00:00.000Z', from, to, rollback });

/**
 * @description 构造服务器分支列表，active 为生效分支。
 * @param names 分支名。
 * @param active 生效分支。
 * @returns 分支列表。
 */
const server = (names: string[], active: string): Branch[] => names.map((branch) => ({ branch, activeWorld: branch === active }));

describe('rollbackTarget', () => {
  test('PA-13：首次切换后回滚到账户原有的非版本分支，而不是从未生效的演练版本分支', () => {
    const history = [switched('default', 'v0.2.0')];
    expect(rollbackTarget(history, server(['default', 'v0.1.15', 'v0.2.0'], 'v0.2.0'))).toEqual({ from: 'v0.2.0', to: 'default' });
  });
  test('PA-13：回滚后发布热修复再回滚，回到上一个生效分支，而不是已知有问题的版本', () => {
    const history = [switched('v0.2.2', 'v0.2.3'), switched('v0.2.3', 'v0.2.4'), switched('v0.2.4', 'v0.2.3', true), switched('v0.2.3', 'v0.2.5')];
    expect(activeStack(history)).toEqual(['v0.2.2', 'v0.2.3', 'v0.2.5']);
    expect(rollbackTarget(history, server(['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5'], 'v0.2.5'))).toEqual({ from: 'v0.2.5', to: 'v0.2.3' });
  });
  test('连续回滚沿生效栈逐级后退', () => {
    const history = [switched('a', 'b'), switched('b', 'c'), switched('c', 'b', true)];
    expect(rollbackTarget(history, server(['a', 'b', 'c'], 'b'))).toEqual({ from: 'b', to: 'a' });
  });
  test('没有记录、记录与服务器不一致、没有更早分支或目标已删除时拒绝', () => {
    expect(() => rollbackTarget([], server(['a', 'b'], 'b'))).toThrow('没有该账户的生效切换记录');
    expect(() => rollbackTarget([switched('a', 'b')], server(['a', 'b', 'c'], 'c'))).toThrow('工具之外');
    expect(() => rollbackTarget([switched(null, 'b')], server(['b'], 'b'))).toThrow('没有早于');
    expect(() => rollbackTarget([switched('a', 'b')], server(['b'], 'b'))).toThrow('已不在服务器上');
  });
  test('期间在工具之外切换过时，生效栈从下一次记录的切换重新开始', () => {
    expect(activeStack([switched('a', 'b'), switched('x', 'y')])).toEqual(['x', 'y']);
  });
  test('ultrareview 第 1 项：重新激活当前生效分支不入栈，回滚仍回到上一个不同的分支，删除保护仍指向它', () => {
    const history = [switched('default', 'v0.1.13'), switched('v0.1.13', 'v0.1.14'), switched('v0.1.14', 'v0.1.14')];
    expect(activeStack(history)).toEqual(['default', 'v0.1.13', 'v0.1.14']);
    const list = server(['default', 'v0.1.13', 'v0.1.14'], 'v0.1.14');
    expect(rollbackTarget(history, list)).toEqual({ from: 'v0.1.14', to: 'v0.1.13' });
    expect(deleteBranchProblem(list, history, 'v0.1.13')).toContain('回滚目标');
  });
  test('ultrareview 第 5 项：配对的切换已被截断的回滚记录不把被回滚掉的分支当作回滚目标', () => {
    const history = [switched('v0.1.20', 'v0.1.19', true), switched('v0.1.19', 'v0.1.21'), switched('v0.1.21', 'v0.1.19', true)];
    expect(activeStack(history)).toEqual(['v0.1.19']);
    expect(() => rollbackTarget(history, server(['v0.1.19', 'v0.1.20', 'v0.1.21'], 'v0.1.19'))).toThrow('没有早于');
  });
});

describe('部署历史', () => {
  test('按账户名与服务器地址分开；记录形状不合法时报错', () => {
    const key = historyKey(selectAccount(secret, 'main'));
    expect(key).toBe('main@https://screeps.com:443');
    expect(accountHistory({}, key)).toEqual([]);
    expect(accountHistory({ [key]: [switched('a', 'b')] }, key)).toEqual([switched('a', 'b')]);
    expect(() => accountHistory({ [key]: [{ to: 'b' }] }, key)).toThrow('形状不合法');
    expect(() => accountHistory([], key)).toThrow('顶层');
  });
  test('审计 DV-06：重新激活当前生效分支不写入历史，反复覆盖不会把真实切换挤出窗口', () => {
    let history = [switched('previous', 'current')];
    for (let i = 0; i < HISTORY_LIMIT + 50; i += 1) history = appendActivation(history, switched('current', 'current'));
    expect(history).toEqual([switched('previous', 'current')]);
    const list = server(['previous', 'current'], 'current');
    expect(rollbackTarget(history, list)).toEqual({ from: 'current', to: 'previous' });
    expect(deleteBranchProblem(list, history, 'previous')).toContain('回滚目标');
  });
  test('只保留最近 HISTORY_LIMIT 条记录', () => {
    let history: Activation[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) history = appendActivation(history, switched(`b${i}`, `b${i + 1}`));
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[HISTORY_LIMIT - 1].to).toBe(`b${HISTORY_LIMIT + 5}`);
  });
});

describe('deleteBranchProblem', () => {
  test('PA-20：拒绝删除不存在的分支、生效或模拟分支，以及当前的回滚目标；其余可以删除', () => {
    const list: Branch[] = [{ branch: 'v0.2.3' }, { branch: 'v0.2.4', activeWorld: true }, { branch: 'sim', activeSim: true }, { branch: 'v0.1.0' }];
    const history = [switched('v0.2.3', 'v0.2.4')];
    expect(deleteBranchProblem(list, history, 'ghost')).toContain('没有分支');
    expect(deleteBranchProblem(list, history, 'v0.2.4')).toContain('生效');
    expect(deleteBranchProblem(list, history, 'sim')).toContain('模拟');
    expect(deleteBranchProblem(list, history, 'v0.2.3')).toContain('回滚目标');
    expect(deleteBranchProblem(list, history, 'v0.1.0')).toBeNull();
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
  test('审计 DV-12：每个请求附带 X-Username（账户名），私服后端缺少它时拒绝认证；令牌不出现在其中', async () => {
    const api = createApi(account, fakeFetch({ ok: 1, list: [] }));
    await api.listBranches();
    await api.getMemory();
    for (const { init } of calls) {
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Username']).toBe('main');
      expect(headers['X-Username']).not.toContain(TOKEN);
    }
  });
  test('inspector 的只读请求：Memory 与 segment 都是 GET，查询参数按需附带，返回 data 字段原样', async () => {
    const api = createApi(account, fakeFetch({ ok: 1, data: 'gz:AAAA' }));
    expect(await api.getMemory('leviathan.sys', 'shard3')).toBe('gz:AAAA');
    expect(await api.getMemory()).toBe('gz:AAAA');
    expect(await api.getSegment(80)).toBe('gz:AAAA');
    expect(calls.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      'GET https://screeps.com/api/user/memory?path=leviathan.sys&shard=shard3',
      'GET https://screeps.com/api/user/memory',
      'GET https://screeps.com/api/user/memory-segment?segment=80',
    ]);
    expect(calls.every(({ url, init }) => init.body === undefined && !url.includes(TOKEN))).toBe(true);
    expect(await createApi(account, fakeFetch({ ok: 1 })).getMemory('missing')).toBeUndefined();
  });
  test('上传、新建分支、切换生效分支与删除分支的请求体', async () => {
    const api = createApi(account, fakeFetch({ ok: 1 }));
    await api.uploadCode('test', { main: 'x' });
    await api.cloneBranch('v0.1.2', { main: 'x' });
    await api.setActiveWorld('v0.1.2');
    await api.deleteBranch('v0.1.0');
    const bodies = calls.map(({ init }) => JSON.parse(init.body as string) as Record<string, unknown>);
    expect(calls.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      'POST https://screeps.com/api/user/code',
      'POST https://screeps.com/api/user/clone-branch',
      'POST https://screeps.com/api/user/set-active-branch',
      'POST https://screeps.com/api/user/delete-branch',
    ]);
    expect(bodies[3]).toEqual({ branch: 'v0.1.0' });
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
