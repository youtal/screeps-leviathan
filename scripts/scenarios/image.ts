/**
 * 文件摘要：私服场景镜像的构建：按白名单整理 Docker 构建上下文、写入 bot 模块表并构建镜像。
 *
 * 所属位置：scripts/scenarios/，开发工具，由场景测试（cli.ts）与基准测试（scripts/bench/cli.ts）共用，不进入游戏构建产物。
 * 副作用：在系统临时目录创建并删除构建上下文；构建并保留指定标签的 Docker 镜像。不读取 .secret.json，不访问游戏服务器。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
export const docker = (args: readonly string[]): number => {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/**
 * @description 按白名单整理构建上下文，写入 bot 模块表，构建镜像后删除上下文。
 * @param tag 镜像标签。
 * @param inputs 白名单：[仓库内路径, 上下文内路径]。
 * @param modules bot 模块表：{ [模块名]: 源码 }，写入上下文的 bot/modules.json。
 * @returns 无返回值；构建并保留镜像。
 * @throws {Error} 白名单中有非普通文件，或镜像构建失败。
 */
export const buildImage = (tag: string, inputs: readonly (readonly [string, string])[], modules: Readonly<Record<string, string>>): void => {
  const context = mkdtempSync(join(tmpdir(), 'leviathan-scenarios-'));
  try {
    for (const [source, target] of inputs) {
      assertRegularTree(source);
      mkdirSync(dirname(join(context, target)), { recursive: true });
      cpSync(source, join(context, target), { recursive: true });
    }
    mkdirSync(join(context, 'bot'));
    writeFileSync(join(context, 'bot', 'modules.json'), JSON.stringify(modules));
    if (docker(['build', '--tag', tag, context]) !== 0) throw new Error('测试镜像构建失败');
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
};
