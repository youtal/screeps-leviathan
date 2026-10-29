/**
 * 文件摘要：私服场景测试的命令行入口，由 package.json 的 test:scenarios 脚本调用。
 *
 * 所属位置：scripts/scenarios/，开发工具，不进入游戏构建产物；由 Node 的类型剥离直接运行，不经编译。
 * 流程：解析参数 → npm run build → 把 dist/main.js 与 source map 整理成模块表（与部署时相同）→
 * 按白名单在临时目录生成 Docker 构建上下文并构建固定标签的测试镜像（image.ts）→ 在隔离容器中运行场景。
 * 场景框架为 screeps-integration-tests，只安装在测试镜像中（test/scenarios/runner）。
 * 副作用：写入 dist/；在系统临时目录创建并删除构建上下文；构建并保留 Docker 镜像 leviathan-scenarios:local。
 * 不读取 .secret.json，不访问游戏服务器；容器运行期禁网。场景失败时以非零状态退出。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { collectModules } from '../deploy/lib.ts';
import { buildImage, docker } from './image.ts';
import { IMAGE, STAGED_INPUTS, parseScenarioArgs, runArguments } from './lib.ts';

const MAIN_FILE = 'dist/main.js';
const MAP_FILE = 'dist/main.js.map';

/**
 * @description 命令行主流程。
 * @returns 进程退出码：场景全部通过为 0。
 * @throws {Error} 参数非法、构建失败或镜像构建失败。
 */
const main = (): number => {
  const args = parseScenarioArgs(process.argv.slice(2));
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  const modules = collectModules(readFileSync(MAIN_FILE, 'utf8'), existsSync(MAP_FILE) ? readFileSync(MAP_FILE, 'utf8') : null);
  buildImage(IMAGE, STAGED_INPUTS, modules);
  return docker(runArguments(IMAGE, args));
};

try {
  process.exitCode = main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
