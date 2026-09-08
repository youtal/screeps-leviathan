import { minify } from 'html-minifier-terser';

export const parseUploadDestination = (args) => {
  if (args.length !== 1) {
    throw new Error(
      'Upload destination is required. Use `npm run upload:validation` or `npm run upload -- DEST:<name>`.'
    );
  }

  const argument = args[0];
  const match = argument.match(/^(?:--)?DEST(?::|=)([^:=\s]+)$/i);
  if (match) return match[1];

  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(argument)) return argument;

  throw new Error(
    `Invalid upload destination argument "${argument}". Use \`npm run upload:validation\` or \`npm run upload -- DEST:<name>\`.`
  );
};

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

const apiUrl = (config, endpoint) => {
  const basePath = config.path === '/' ? '' : config.path.replace(/\/$/, '');
  return new URL(
    `${basePath}${endpoint}`,
    `${config.protocol}://${config.hostname}:${config.port}`
  );
};

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
