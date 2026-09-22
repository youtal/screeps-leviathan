/**
 * 集成测试隔离入口：只将锁定 runner、正式产物、Core 探针产物和场景复制进临时 Docker 构建上下文。
 * 旧引擎的安装脚本在容器构建层执行；运行期禁网、只读根文件系统、非 root、无宿主挂载。
 * 不继承宿主凭据到容器，不回退到宿主 node_modules；失败时返回非零退出码供 CI 判断。
 */
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rollup } from 'rollup';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 只允许普通文件/目录，避免白名单入口中的符号链接把凭据或其他宿主文件带入上下文。 */
function assertRegularTree(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) assertRegularTree(join(path, name));
  } else if (!stat.isFile()) {
    throw new Error(`Unsupported integration input: ${path}`);
  }
}

export function stageContext(projectRoot, destination) {
  const inputs = [
    ['test/integration/runner/Dockerfile', 'Dockerfile'],
    ['test/integration/runner/package.json', 'package.json'],
    ['test/integration/runner/package-lock.json', 'package-lock.json'],
    ['test/integration/runner/.npmrc', '.npmrc'],
    ['dist/main.js', 'dist/main.js'],
    ['dist/main.js.map', 'dist/main.js.map'],
    ['test/integration/scenarios', 'scenarios'],
    ['test/integration/support', 'support'],
    ['screeps-integration.config.cjs', 'screeps-integration.config.cjs'],
  ];
  for (const [source, target] of inputs) {
    const from = join(projectRoot, source);
    const to = join(destination, target);
    assertRegularTree(from);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  // 只提取测试所需的容量标量，容器不需要读取或挂载项目 TypeScript 源码。
  // 容器不访问宿主源码：只从 MemoryManager 常量提取容量标量，供容量场景断言使用。
  const sourcePath = join(projectRoot, 'src/core/memoryManager/types.ts');
  assertRegularTree(sourcePath);
  const match = /RAW_MEMORY_LIMIT\s*=\s*([\d_]+)/.exec(
    readFileSync(sourcePath, 'utf8')
  );
  if (!match)
    throw new Error('Missing RAW_MEMORY_LIMIT in MemoryManager contract');
  const limit = Number(match[1].replaceAll('_', ''));
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('Invalid RAW_MEMORY_LIMIT');
  writeFileSync(
    join(destination, 'support/contract.json'),
    JSON.stringify({ rawMemoryLimit: limit })
  );
}

/**
 * 把 src/core 的公共入口编译为独立 CJS 模块（与正式构建相同的插件组合），写入构建上下文的
 * support/leviathan-core.js。Memory 场景用它装配带持久化插件的探针 bot；正式 app 产物没有
 * 申请分区的插件，无法覆盖真实引擎中的写盘、容量与硬终止路径。只写入临时上下文，不污染 dist/。
 */
export async function bundleCore(projectRoot, destination) {
  const bundle = await rollup({
    input: join(projectRoot, 'src/core/index.ts'),
    plugins: [
      nodeResolve(),
      commonjs(),
      typescript({
        tsconfig: join(projectRoot, 'tsconfig.json'),
        include: ['src/**/*.ts'],
        check: false,
      }),
    ],
  });
  try {
    const { output } = await bundle.generate({ format: 'cjs' });
    writeFileSync(join(destination, 'support/leviathan-core.js'), output[0].code);
  } finally {
    await bundle.close();
  }
}

export function runArguments(image, cliArgs) {
  return [
    'run',
    '--rm',
    '--init',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    '--memory=4g',
    '--cpus=2',
    '--user=1000:1000',
    '--workdir=/work',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=512m',
    '--tmpfs=/work:rw,nosuid,nodev,uid=1000,gid=1000,size=512m',
    image,
    ...cliArgs,
  ];
}

function docker(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Docker exited with ${result.status ?? result.signal}`);
}

/** 参数校验同步完成（非法参数立即抛出），其余步骤返回 Promise。 */
export function main(args) {
  if (
    args.length &&
    !(
      args.length === 2 &&
      args[0] === '--only' &&
      /^[a-zA-Z0-9_-]+$/.test(args[1])
    )
  ) {
    throw new Error(
      'Usage: npm run test:integration -- [--only scenario-name]'
    );
  }
  return run(args);
}

async function run(args) {
  const context = mkdtempSync(join(tmpdir(), 'leviathan-integration-'));
  const image = `leviathan-integration:${process.pid}`;
  let built = false;
  try {
    stageContext(root, context);
    await bundleCore(root, context);
    docker(['build', '--tag', image, context]);
    built = true;
    docker(runArguments(image, args));
  } finally {
    rmSync(context, { recursive: true, force: true });
    if (built)
      spawnSync('docker', ['image', 'rm', image], { stdio: 'inherit' });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
