/**
 * 文件摘要：私服场景测试运行器的纯函数实现，供 cli.ts 与单元测试使用。
 *
 * 所属位置：scripts/scenarios/，开发工具，不进入游戏构建产物。
 * 主要能力：解析命令行参数；给出构建上下文的白名单；生成隔离运行容器的 docker run 参数。
 * 本文件不读写文件、不启动进程，所有输入由调用方提供。
 */
import { parseArgs } from 'node:util';

/** 场景测试镜像的固定标签：依赖层不变时复用缓存，每次运行覆盖产物与场景层。 */
export const IMAGE = 'leviathan-scenarios:local';

/** 用法说明。 */
export const USAGE = '用法：npm run test:scenarios -- [--only <场景名>]（场景名为 test/scenarios/scenarios 下去掉 .scenario.js 的文件名）';

/** 场景名：小写字母、数字与连字符。 */
const SCENARIO_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 构建上下文的白名单：[仓库内路径, 上下文内路径]。只复制这些普通文件与目录，
 * 构建产物以模块表（bot/modules.json）形式另行写入，不复制 dist/ 以外的源码或任何凭据。
 */
export const STAGED_INPUTS: readonly (readonly [string, string])[] = [
  ['test/scenarios/runner/Dockerfile', 'Dockerfile'],
  ['test/scenarios/runner/package.json', 'package.json'],
  ['test/scenarios/runner/package-lock.json', 'package-lock.json'],
  ['test/scenarios/runner/.npmrc', '.npmrc'],
  ['test/scenarios/scenarios.config.cjs', 'scenarios.config.cjs'],
  ['test/scenarios/scenarios', 'scenarios'],
  ['test/scenarios/support', 'support'],
];

/** 解析后的命令行参数。 */
export interface ScenarioArgs {
  /** 只运行这一个场景；未给出时运行全部场景。 */
  readonly only?: string;
}

/**
 * @description 解析命令行参数。
 * @param argv 去掉 node 与脚本路径后的命令行参数。
 * @returns 解析结果。
 * @throws {Error} 出现未知选项、位置参数，或场景名不合法；消息包含用法说明。
 * @example parseScenarioArgs(['--only', 'kernel-smoke'])
 */
export const parseScenarioArgs = (argv: readonly string[]): ScenarioArgs => {
  let values: { only?: string };
  try {
    ({ values } = parseArgs({ args: [...argv], options: { only: { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${USAGE}`);
  }
  if (values.only !== undefined && !SCENARIO_NAME.test(values.only)) {
    throw new Error(`场景名不合法：${values.only}\n${USAGE}`);
  }
  return values.only === undefined ? {} : { only: values.only };
};

/**
 * @description 生成运行场景容器的 docker run 参数：禁网、只读根文件系统、去掉全部能力、非 root、限制资源，
 * 只挂载内存文件系统作为工作目录，不挂载宿主目录、不传入宿主环境变量。
 * @param image 镜像标签。
 * @param args 解析后的命令行参数。
 * @returns docker 的参数列表（不含 docker 本身）。
 */
export const runArguments = (image: string, args: ScenarioArgs): string[] => [
  'run', '--rm', '--init',
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
  ...(args.only === undefined ? [] : ['--only', args.only]),
];
