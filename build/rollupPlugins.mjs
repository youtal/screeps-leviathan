/**
 * 文件摘要：提供 Rollup 构建期插件与 Screeps 上传客户端，供 rollup.config.mjs 与
 * build/upload.mjs 复用。
 *
 * 主要能力：parseUploadDestination 解析命令行上传目标；htmlString 把 .html 模板压缩成
 * 可直接 import 的 JS 字符串模块；screepsUpload 在 writeBundle 阶段把构建产物上传到
 * 指定分支并回读校验。
 *
 * 运行环境是 Node 构建进程（不是 Screeps 运行时），因此可以使用 fetch/Buffer 等能力；
 * 副作用集中在 screepsUpload：它会向 Screeps 官方 API 发起真实 HTTP 请求，凭据来自
 * 调用方传入的 config（通常取自 .secret.json）。本文件不读取 .secret.json，也不写入磁盘。
 */
import { minify } from 'html-minifier-terser';

/**
 * 解析上传目标，兼容 `npm run upload -- DEST:<name>`、`--DEST=<name>` 与裸目标名三种写法。
 * 只接受恰好一个参数：rollup CLI 会把 `--environment` 等选项一并透传，参数个数或格式不对时
 * 必须立即抛错，否则会静默地「编译但不上传」，让使用者误以为已经部署。
 */
export const parseUploadDestination = (args) => {
  if (args.length !== 1) {
    throw new Error(
      'Upload destination is required. Use `npm run upload:validation` or `npm run upload -- DEST:<name>`.'
    );
  }

  const argument = args[0];
  // 匹配可选的 `--` 前缀 + DEST + `:` 或 `=` + 非空且不含空格/分隔符的目标名。
  const match = argument.match(/^(?:--)?DEST(?::|=)([^:=\s]+)$/i);
  if (match) return match[1];

  // 裸目标名（如 validation）同样接受；字符集限制避免路径片段或带空格的参数被当成目标。
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(argument)) return argument;

  throw new Error(
    `Invalid upload destination argument "${argument}". Use \`npm run upload:validation\` or \`npm run upload -- DEST:<name>\`.`
  );
};

/**
 * 插件工厂：只在 id 以 .html 结尾（允许带 query 后缀）时接管，其余模块返回 null 交回
 * rollup 默认流程。压缩后的 HTML 以 JSON.stringify 生成字符串字面量导出，使
 * `import tpl from './x.html'` 得到可直接使用的文本；map.mappings 为空表示不为 HTML 生成源映射。
 */
export const htmlString = (options = {}) => ({
  name: 'html-string',

  async transform(code, id) {
    if (!/\.html(?:\?.*)?$/.test(id)) return null;

    const html = await minify(code, options.htmlMinifierOptions);
    return {
      code: `export default ${JSON.stringify(html)};`,
      map: { mappings: '' },
    };
  },
});

/** 拼接 API 地址：path 为 '/' 时视为无前缀，其他情况去掉结尾 '/' 再与 protocol://host:port 组合。 */
const apiUrl = (config, endpoint) => {
  const basePath = config.path === '/' ? '' : config.path.replace(/\/$/, '');
  return new URL(
    `${basePath}${endpoint}`,
    `${config.protocol}://${config.hostname}:${config.port}`
  );
};

/**
 * 统一的 JSON 请求封装：注入 X-Token 鉴权头，可选 query 参数，body 自动序列化。
 * 失败路径全部转成带 endpoint 与原因的异常——网络层不 ok、业务 ok !== 1、响应不是合法
 * JSON 都会让构建失败，避免出现「命令成功但代码其实没上传」的静默错误。
 */
const request = async (config, endpoint, options = {}) => {
  const url = apiUrl(config, endpoint);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Token': config.token,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Screeps API ${options.method ?? 'GET'} ${endpoint} returned invalid JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok || data.ok !== 1) {
    const reason = data.error ?? data.message ?? `HTTP ${response.status}`;
    throw new Error(
      `Screeps API ${options.method ?? 'GET'} ${endpoint} failed: ${reason}`
    );
  }

  return data;
};

/**
 * 把 Rollup 输出整理成 Screeps 模块表：chunk 用去掉 .js 的文件名作为模块名；sourcemap
 * 剥离 sourcesContent（减小体积并避免上传源码全文），并用 `module.exports = {...}` 包装，
 * 因为游戏内 require 只能取到 CJS 导出。wasm 资源以 base64 形式传递。
 */
const collectModules = (bundle) => {
  const modules = {};

  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk') {
      const moduleName = output.fileName.replace(/\.js$/i, '');
      modules[moduleName] = output.code;

      if (output.map) {
        const map = JSON.parse(output.map.toString());
        delete map.sourcesContent;
        modules[`${output.fileName}.map`] =
          `module.exports = ${JSON.stringify(map)};`;
      }
    } else if (output.fileName.endsWith('.wasm')) {
      modules[output.fileName] = {
        binary: Buffer.from(output.source).toString('base64'),
      };
    }
  }

  return modules;
};

/** 上传前校验配置形状：把 .secret.json 的填写错误挡在第一次网络请求之前，避免中途失败留下不一致状态。 */
const validateConfig = (config) => {
  if (
    !config ||
    typeof config.token !== 'string' ||
    !['http', 'https'].includes(config.protocol) ||
    typeof config.hostname !== 'string' ||
    typeof config.port !== 'number' ||
    typeof config.path !== 'string' ||
    typeof config.branch !== 'string'
  ) {
    throw new TypeError('Invalid Screeps upload configuration');
  }
};

/**
 * 上传调用约定：先 GET /api/user/branches 判断目标分支是否存在；存在则 POST
 * /api/user/code（带 _hash 客户端时间戳，避免服务端复用旧响应），否则 POST
 * /api/user/clone-branch 以 branch:'' + newName + defaultModules 新建分支。
 * 最后 GET /api/user/code?branch=... 回读并逐模块比对，任何不一致都抛错，
 * 保证「上传成功」判定基于服务端实际保存的内容。
 */
const uploadModules = async (config, modules) => {
  const branches = await request(config, '/api/user/branches');
  const branchExists = branches.list.some(
    ({ branch }) => branch === config.branch
  );

  if (branchExists) {
    await request(config, '/api/user/code', {
      method: 'POST',
      body: { branch: config.branch, modules, _hash: Date.now() },
    });
  } else {
    await request(config, '/api/user/clone-branch', {
      method: 'POST',
      body: {
        branch: '',
        newName: config.branch,
        defaultModules: modules,
      },
    });
  }

  const uploaded = await request(config, '/api/user/code', {
    query: { branch: config.branch },
  });
  for (const [name, content] of Object.entries(modules)) {
    if (JSON.stringify(uploaded.modules[name]) !== JSON.stringify(content)) {
      throw new Error(`Screeps upload verification failed for module ${name}`);
    }
  }
};

/**
 * 上传插件工厂：构造时立即校验配置，使配置错误在 rollup 启动阶段就暴露，而不是等构建
 * 完成后才失败；真正的网络副作用只发生在 writeBundle 钩子中，成功时输出模块数与分支名。
 */
export const screepsUpload = ({ config }) => {
  validateConfig(config);

  return {
    name: 'screeps-upload',

    async writeBundle(_outputOptions, bundle) {
      const modules = collectModules(bundle);
      await uploadModules(config, modules);
      console.log(
        `uploaded and verified ${Object.keys(modules).length} modules in Screeps branch ${config.branch}`
      );
    },
  };
};
