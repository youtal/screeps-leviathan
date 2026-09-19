/**
 * 集成测试隔离入口：只将锁定 runner、正式产物和场景复制进临时 Docker 构建上下文。
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
  const sourcePath = join(projectRoot, 'src/core/memoryManager/types.ts');
  assertRegularTree(sourcePath);
  const match = /SEGMENT_CAPACITY\s*=\s*([\d_]+)/.exec(
    readFileSync(sourcePath, 'utf8')
  );
  if (!match)
    throw new Error('Missing SEGMENT_CAPACITY in MemoryManager contract');
  const capacity = Number(match[1].replaceAll('_', ''));
  if (!Number.isSafeInteger(capacity) || capacity <= 0)
    throw new Error('Invalid SEGMENT_CAPACITY');
  writeFileSync(
    join(destination, 'support/contract.json'),
    JSON.stringify({ segmentCapacity: capacity })
  );
}

/** 参数由固定列表构造，不接受任意 docker run 参数、环境变量转发或宿主挂载。 */
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

export function main(args) {
  // 只支持选场景，不能让调用方把配置路径改到任意宿主/镜像位置。
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
  const context = mkdtempSync(join(tmpdir(), 'leviathan-integration-'));
  const image = `leviathan-integration:${process.pid}`;
  let built = false;
  try {
    stageContext(root, context);
    docker(['build', '--tag', image, context]);
    built = true;
    docker(runArguments(image, args));
  } finally {
    rmSync(context, { recursive: true, force: true });
    // 仅清理本次临时 tag，不触及其他镜像或 Docker 构建缓存。
    if (built)
      spawnSync('docker', ['image', 'rm', image], { stdio: 'inherit' });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
