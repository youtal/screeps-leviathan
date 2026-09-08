import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  htmlString,
  parseUploadDestination,
  screepsUpload,
} from '../build/rollupPlugins.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const config = {
  token: 'test-token',
  protocol: 'https',
  hostname: 'example.com',
  port: 443,
  path: '/',
  branch: 'validation',
};

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
