/**
 * 文件摘要：私服场景测试的命令行入口，由 package.json 的 test:scenarios 脚本调用。
 *
 * 所属位置：scripts/scenarios/，开发工具，不进入游戏构建产物；由 Node 的类型剥离直接运行，不经编译。
 * 流程：解析参数 → npm run build → 把 dist/main.js 与 source map 整理成模块表（与部署时相同）→
 * 按白名单在临时目录生成 Docker 构建上下文 → 构建固定标签的测试镜像 → 在隔离容器中运行场景 → 删除临时目录。
 * 场景框架为 screeps-integration-tests，只安装在测试镜像中（test/scenarios/runner）。
 * 副作用：写入 dist/；在系统临时目录创建并删除构建上下文；构建并保留 Docker 镜像 leviathan-scenarios:local。
 * 不读取 .secret.json，不访问游戏服务器；容器运行期禁网。场景失败时以非零状态退出。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { collectModules } from '../deploy/lib.ts';
import { IMAGE, STAGED_INPUTS, parseScenarioArgs, runArguments } from './lib.ts';

const MAIN_FILE = 'dist/main.js';
const MAP_FILE = 'dist/main.js.map';

/**
 * @description 确认路径是普通文件或只含普通文件的目录，避免符号链接把白名单之外的宿主文件带入构建上下文。
 * @param path 待检查的路径。
 * @returns 无返回值。
 * @throws {Error} 路径中有符号链接或其他非普通文件。
 */
const assertRegularTree = (path: string): void => {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) assertRegularTree(join(path, name));
  } else if (!stat.isFile()) {
    throw new Error(`构建上下文只接受普通文件：${path}`);
  }
};

/**
 * @description 运行 docker 命令，输出直接显示在终端。
 * @param args docker 的参数。
 * @returns docker 的退出状态。
 * @throws {Error} 无法启动 docker。
 */
const docker = (args: readonly string[]): number => {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/**
 * @description 命令行主流程。
 * @returns 进程退出码：场景全部通过为 0。
 * @throws {Error} 参数非法、构建失败或镜像构建失败。
 */
const main = (): number => {
  const args = parseScenarioArgs(process.argv.slice(2));
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  const modules = collectModules(readFileSync(MAIN_FILE, 'utf8'), existsSync(MAP_FILE) ? readFileSync(MAP_FILE, 'utf8') : null);
  const context = mkdtempSync(join(tmpdir(), 'leviathan-scenarios-'));
  try {
    for (const [source, target] of STAGED_INPUTS) {
      assertRegularTree(source);
      mkdirSync(dirname(join(context, target)), { recursive: true });
      cpSync(source, join(context, target), { recursive: true });
    }
    mkdirSync(join(context, 'bot'));
    writeFileSync(join(context, 'bot', 'modules.json'), JSON.stringify(modules));
    if (docker(['build', '--tag', IMAGE, context]) !== 0) throw new Error('测试镜像构建失败');
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
  return docker(runArguments(IMAGE, args));
};

try {
  process.exitCode = main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
