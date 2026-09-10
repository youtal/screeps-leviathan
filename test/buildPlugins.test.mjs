/**
 * 文件摘要：验证构建期 Rollup 插件与 Screeps 上传客户端（build/rollupPlugins.mjs）。
 *
 * 覆盖模块：parseUploadDestination（CLI 目标解析）、htmlString（.html 模板转为压缩后的
 * JS 字符串）、screepsUpload（分支已存在时上传、缺失时 clone-branch、上传后回读校验）。
 * 覆盖边界：三种合法参数写法与各类非法参数、非 .html 模块不被接管、请求序列与上传内容、
 * sourcemap 的包装形式与 sourcesContent 剥离。
 *
 * 替代实现：用 node:test 与 node:assert/strict 运行，把 globalThis.fetch 替换为脚本化响应，
 * 从而在不联网、不使用 .secret.json 的前提下走完整个上传流程；config 中是不含真实凭据的假配置。
 * fetch 是本文件唯一的网络出口，afterEach 必须恢复原值，避免污染同进程后续用例。
 *
 * 运行方式：npm test 的第二步 `node test/buildPlugins.test.mjs`（jest 的 testMatch 只匹配
 * *.test.ts，因此本文件不会被 jest 执行）。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  htmlString,
  parseUploadDestination,
  screepsUpload,
} from '../build/rollupPlugins.mjs';

// 保存原始 fetch 供 afterEach 还原：用例内的替代实现只服务于当前用例。
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 手工整流：插件只依赖 ok/status/text()，避免引入真实 Response 实现与 undici 细节。 */
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

/** 上传目标配置：字段形状与 .secret.json 中单个目标一致；token 为假值，只用于验证请求组装。 */
const config = {
  token: 'test-token',
  protocol: 'https',
  hostname: 'example.com',
  port: 443,
  path: '/',
  branch: 'validation',
};

/** 最小 Rollup OutputBundle：map 提供 toString()（rollup SourceMap 的对外契约），即可覆盖 sourcemap 处理分支。 */
const bundle = {
  'main.js': {
    type: 'chunk',
    fileName: 'main.js',
    code: 'module.exports.loop = () => {};',
    map: {
      toString: () =>
        JSON.stringify({
          version: 3,
          sources: ['src/index.ts'],
          sourcesContent: ['source text'],
          mappings: '',
        }),
    },
  },
};

/**
 * 命令行写法必须与 npm scripts 的组合一致（`-- DEST:x`、`--DEST=x`、裸名字），
 * 而参数缺失、多余或畸形要在发起上传前失败，避免把错误目标上传到线上分支。
 */
test('upload destination parser accepts supported forms and rejects ambiguous arguments', () => {
  assert.equal(parseUploadDestination(['validation']), 'validation');
  assert.equal(parseUploadDestination(['DEST:validation']), 'validation');
  assert.equal(parseUploadDestination(['--DEST=validation']), 'validation');
  assert.throws(() => parseUploadDestination([]), /destination is required/i);
  assert.throws(
    () => parseUploadDestination(['--environment', 'DEST:validation']),
    /destination is required/i
  );
  assert.throws(
    () => parseUploadDestination(['--environment']),
    /invalid upload destination argument/i
  );
});

/** 只有 .html 后缀才接管，其他模块返回 null 交回 rollup 默认处理；产物是 `export default "<minified html>"`，让 TS 能像模块一样 import 模板。 */
test('htmlString imports minified HTML as a JavaScript string', async () => {
  const plugin = htmlString({
    htmlMinifierOptions: {
      collapseWhitespace: true,
      removeComments: true,
    },
  });
  const result = await plugin.transform(
    '<!-- comment --><div>  content </div>',
    '/tmp/template.html'
  );

  assert.equal(result.code, 'export default "<div>content</div>";');
  assert.equal(await plugin.transform('text', '/tmp/file.ts'), null);
});

/**
 * 脚本化 fetch 记录请求序列并暂存 POST 上来的模块表，用于验证完整调用约定：
 * 先查分支列表 → 存在则 POST /api/user/code → 最后 GET /api/user/code 回读校验。
 * 回读校验用于发现「请求成功但内容不一致」的静默失败；sourcemap 用 module.exports 包装
 * 是为了让游戏内 require('main.js.map') 直接取到对象，且其中不再包含 sourcesContent。
 */
test('screepsUpload updates an existing branch and verifies its modules', async () => {
  const calls = [];
  let uploadedModules;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push([url.pathname, method]);

    if (url.pathname.endsWith('/branches')) {
      return response({ ok: 1, list: [{ branch: config.branch }] });
    }
    if (method === 'POST') {
      uploadedModules = JSON.parse(options.body).modules;
      return response({ ok: 1 });
    }
    return response({
      ok: 1,
      branch: config.branch,
      modules: uploadedModules,
    });
  };

  await screepsUpload({ config }).writeBundle({}, bundle);

  assert.deepEqual(calls, [
    ['/api/user/branches', 'GET'],
    ['/api/user/code', 'POST'],
    ['/api/user/code', 'GET'],
  ]);
  assert.equal(uploadedModules.main, bundle['main.js'].code);
  assert.match(uploadedModules['main.js.map'], /^module\.exports = /);
  assert.doesNotMatch(uploadedModules['main.js.map'], /source text/);
});

/** 分支不存在时必须用 clone-branch 创建，并通过 defaultModules 传入本次构建产物；branch 传空串表示不基于任何现有分支。 */
test('screepsUpload creates and verifies a missing branch', async () => {
  let cloneBody;
  globalThis.fetch = async (url, options = {}) => {
    if (url.pathname.endsWith('/branches')) {
      return response({ ok: 1, list: [] });
    }
    if (url.pathname.endsWith('/clone-branch')) {
      cloneBody = JSON.parse(options.body);
      return response({ ok: 1 });
    }
    return response({
      ok: 1,
      branch: config.branch,
      modules: cloneBody.defaultModules,
    });
  };

  await screepsUpload({ config }).writeBundle({}, bundle);

  assert.equal(cloneBody.branch, '');
  assert.equal(cloneBody.newName, config.branch);
  assert.equal(cloneBody.defaultModules.main, bundle['main.js'].code);
});
