/**
 * 文件摘要：Screeps 代码分支 API 的客户端，供 cli.ts 使用。
 *
 * 所属位置：scripts/deploy/，开发工具，不进入游戏构建产物。
 * 封装的接口（均以 X-Token 请求头鉴权）：
 * - GET  /api/user/branches：列出代码分支及生效标记；
 * - GET  /api/user/code?branch=：读取分支代码，用于上传后回读校验；
 * - POST /api/user/code：覆盖已存在分支的代码（分支不存在时服务器报错）；
 * - POST /api/user/clone-branch：以给定模块新建分支（服务器限制每个账户的分支数量）；
 * - POST /api/user/set-active-branch：切换世界（activeWorld）的生效分支；
 * - POST /api/user/delete-branch：删除分支（服务器对生效分支静默不删、仍返回成功，调用方须先检查并回读确认）。
 * 副作用：发起真实网络请求。fetch 由调用方注入，测试中替换为假实现。
 * 令牌只放在请求头中，不出现在 URL、日志或错误消息里。
 */
import type { Account, Branch, Modules } from './lib.ts';
import { serverOrigin } from './lib.ts';

/** 单次请求的超时（毫秒）；覆盖连接与读取响应体，避免服务器无响应时进程挂起。 */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface ScreepsApi {
  /**
   * @description 列出账户的代码分支及生效标记（GET /api/user/branches）。
   * @returns 分支名与 activeWorld、activeSim 标记，不含模块内容。
   * @throws {Error} 请求失败、超时、响应不是 JSON 或 ok !== 1。
   */
  listBranches(): Promise<Branch[]>;
  /**
   * @description 读取分支代码（GET /api/user/code），用于上传后回读校验。
   * @param branch 分支名。
   * @returns 模块名到模块内容的映射。
   * @throws {Error} 请求失败、超时、响应不是 JSON 或 ok !== 1。
   */
  getCode(branch: string): Promise<Record<string, unknown>>;
  /**
   * @description 覆盖已存在分支的代码（POST /api/user/code）；分支不存在时服务器报错。
   * @param branch 分支名。
   * @param modules 上传的模块表。
   * @returns 无返回值；服务器确认后完成。
   * @throws {Error} 请求失败、超时、响应不是 JSON 或 ok !== 1。
   */
  uploadCode(branch: string, modules: Modules): Promise<void>;
  /**
   * @description 以给定模块新建分支（POST /api/user/clone-branch）；服务器限制每个账户的分支数量。
   * @param newName 新分支名。
   * @param modules 新分支的模块表。
   * @returns 无返回值；服务器确认后完成。
   * @throws {Error} 请求失败、超时、响应不是 JSON 或 ok !== 1（例如分支数已满）。
   */
  cloneBranch(newName: string, modules: Modules): Promise<void>;
  /**
   * @description 切换世界的生效分支（POST /api/user/set-active-branch，activeName 为 activeWorld）。
   * @param branch 目标分支名。
   * @returns 无返回值；服务器确认后完成。
   * @throws {Error} 请求失败、超时、响应不是 JSON 或 ok !== 1。
   */
  setActiveWorld(branch: string): Promise<void>;
  /**
   * @description 删除分支（POST /api/user/delete-branch）。backend 3.3.0 对生效分支与模拟分支静默不删、仍返回成功，
   * 所以调用方须先检查，并在删除后重新列出分支确认。
   * @param branch 分支名。
   * @returns 无返回值；服务器确认后完成。
   * @throws {Error} 请求失败、超时、响应不是 JSON 或 ok !== 1。
   */
  deleteBranch(branch: string): Promise<void>;
}

/**
 * @description 创建绑定到一个账户的客户端。
 * 每个请求都检查 HTTP 状态与响应中的 ok 字段：网络失败、超时、响应不是 JSON、ok !== 1 都抛错，
 * 不把失败当作成功继续执行。
 * @param account 目标账户；令牌只放进 X-Token 请求头。
 * @param fetchImpl 发起请求的 fetch 实现，默认使用全局 fetch，测试中替换为假实现。
 * @param timeoutMs 单次请求的超时（毫秒），默认 REQUEST_TIMEOUT_MS。
 * @returns 绑定该账户的 Screeps API 客户端。
 */
export const createApi = (account: Account, fetchImpl: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): ScreepsApi => {
  const origin = serverOrigin(account);

  /**
   * @description 发起一次带鉴权的 JSON 请求，并把各种失败统一转为带接口标签的异常；异常消息不含令牌。
   * @param method HTTP 方法。
   * @param endpoint /api/user 之后的路径，例如 '/branches'。
   * @param options 请求选项。
   * @param options.query 查询参数。
   * @param options.body 请求体，按 JSON 序列化；省略时不发送请求体。
   * @returns 解析后的响应对象（ok 为 1）。
   * @throws {Error} 网络失败、超时、响应不是 JSON、HTTP 状态非 2xx 或 ok !== 1。
   */
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
    /**
     * @description 列出分支并只保留分支名与生效标记，丢弃服务器一并返回的模块内容。
     * @returns 分支列表。
     * @throws {Error} 请求失败。
     */
    async listBranches() {
      const data = await request('GET', '/branches');
      return (data.list as Branch[]).map(({ branch, activeWorld, activeSim }) => ({ branch, activeWorld, activeSim }));
    },
    /**
     * @description 读取指定分支的模块表。
     * @param branch 分支名。
     * @returns 模块名到模块内容的映射。
     * @throws {Error} 请求失败。
     */
    async getCode(branch) {
      const data = await request('GET', '/code', { query: { branch } });
      return data.modules as Record<string, unknown>;
    },
    /**
     * @description 覆盖已存在分支的代码。
     * @param branch 分支名。
     * @param modules 上传的模块表。
     * @returns 无返回值。
     * @throws {Error} 请求失败，包括分支不存在。
     */
    async uploadCode(branch, modules) {
      // _hash 是客户端时间戳，服务器随代码更新通知原样转发，用于区分不同的上传。
      await request('POST', '/code', { body: { branch, modules, _hash: Date.now() } });
    },
    /**
     * @description 以给定模块新建分支。
     * @param newName 新分支名。
     * @param modules 新分支的模块表。
     * @returns 无返回值。
     * @throws {Error} 请求失败，包括分支数已满。
     */
    async cloneBranch(newName, modules) {
      // branch 为空表示不从已有分支复制，直接以 defaultModules 作为新分支的代码。
      await request('POST', '/clone-branch', { body: { branch: '', newName, defaultModules: modules } });
    },
    /**
     * @description 切换世界的生效分支。
     * @param branch 目标分支名。
     * @returns 无返回值。
     * @throws {Error} 请求失败。
     */
    async setActiveWorld(branch) {
      await request('POST', '/set-active-branch', { body: { branch, activeName: 'activeWorld' } });
    },
    /**
     * @description 删除分支。
     * @param branch 分支名。
     * @returns 无返回值。
     * @throws {Error} 请求失败。
     */
    async deleteBranch(branch) {
      await request('POST', '/delete-branch', { body: { branch } });
    },
  };
};
