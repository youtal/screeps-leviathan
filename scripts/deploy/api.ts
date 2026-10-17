/**
 * 文件摘要：Screeps 代码分支 API 的客户端，供 cli.ts 使用。
 *
 * 所属位置：scripts/deploy/，开发工具，不进入游戏构建产物。
 * 封装的接口（均以 X-Token 请求头鉴权）：
 * - GET  /api/user/branches：列出代码分支及生效标记；
 * - GET  /api/user/code?branch=：读取分支代码，用于上传后回读校验；
 * - POST /api/user/code：覆盖已存在分支的代码（分支不存在时服务器报错）；
 * - POST /api/user/clone-branch：以给定模块新建分支（服务器限制每个账户的分支数量）；
 * - POST /api/user/set-active-branch：切换世界（activeWorld）的生效分支。
 * 副作用：发起真实网络请求。fetch 由调用方注入，测试中替换为假实现。
 * 令牌只放在请求头中，不出现在 URL、日志或错误消息里。
 */
import type { Account, Branch, Modules } from './lib.ts';
import { serverOrigin } from './lib.ts';

/** 单次请求的超时（毫秒）；覆盖连接与读取响应体，避免服务器无响应时进程挂起。 */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface ScreepsApi {
  listBranches(): Promise<Branch[]>;
  getCode(branch: string): Promise<Record<string, unknown>>;
  uploadCode(branch: string, modules: Modules): Promise<void>;
  cloneBranch(newName: string, modules: Modules): Promise<void>;
  setActiveWorld(branch: string): Promise<void>;
}

/**
 * 创建绑定到一个账户的客户端。
 * 每个请求都检查 HTTP 状态与响应中的 ok 字段：网络失败、超时、响应不是 JSON、ok !== 1 都抛错，
 * 不把失败当作成功继续执行。
 */
export const createApi = (account: Account, fetchImpl: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): ScreepsApi => {
  const origin = serverOrigin(account);

  const request = async (
    method: 'GET' | 'POST',
    endpoint: string,
    options: { readonly query?: Record<string, string>; readonly body?: unknown } = {},
  ): Promise<Record<string, unknown>> => {
    const url = new URL(`${origin}/api/user${endpoint}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const label = `${method} /api/user${endpoint}`;
    let status: number;
    let text: string;
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Token': account.token },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`${label} 超过 ${timeoutMs} ms 未完成`);
      }
      throw new Error(`${label} 请求失败：${(error as Error).message}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${label} 返回的不是 JSON（HTTP ${status}）`);
    }
    const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
    if (status < 200 || status >= 300 || record.ok !== 1) {
      const reason = typeof record.error === 'string' ? record.error : `HTTP ${status}`;
      throw new Error(`${label} 失败：${reason}`);
    }
    return record;
  };

  return {
    async listBranches() {
      const data = await request('GET', '/branches');
      return (data.list as Branch[]).map(({ branch, activeWorld, activeSim }) => ({ branch, activeWorld, activeSim }));
    },
    async getCode(branch) {
      const data = await request('GET', '/code', { query: { branch } });
      return data.modules as Record<string, unknown>;
    },
    async uploadCode(branch, modules) {
      // _hash 是客户端时间戳，服务器随代码更新通知原样转发，用于区分不同的上传。
      await request('POST', '/code', { body: { branch, modules, _hash: Date.now() } });
    },
    async cloneBranch(newName, modules) {
      // branch 为空表示不从已有分支复制，直接以 defaultModules 作为新分支的代码。
      await request('POST', '/clone-branch', { body: { branch: '', newName, defaultModules: modules } });
    },
    async setActiveWorld(branch) {
      await request('POST', '/set-active-branch', { body: { branch, activeName: 'activeWorld' } });
    },
  };
};
