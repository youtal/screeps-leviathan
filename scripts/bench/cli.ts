/**
 * 文件摘要：基准测试的命令行入口，由 package.json 的 bench 脚本调用。
 *
 * 所属位置：scripts/bench/，开发工具，不进入游戏构建产物；由 Node 的类型剥离直接运行，不经编译。设计见 docs/proposal/2026-10-22-bench.md。
 * 流程：解析参数 → npm run build:bench（打包 test/bench/main.ts）→ 整理模块表并构建镜像 leviathan-bench:local（与场景测试共用
 * scripts/scenarios/image.ts）→ 在与场景测试相同的隔离容器中只运行 bench 场景 → 从输出中提取原始结果 → 汇总并与基准文件比较。
 * 副作用：写入 dist/bench/；构建并保留 Docker 镜像；指定 --update 时覆盖 test/bench/baseline.json。
 * 不读取 .secret.json，不访问游戏服务器；容器运行期禁网。工作量计数改变或 CPU 回归时以非零状态退出。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { collectModules } from '../deploy/lib.ts';
import { buildImage } from '../scenarios/image.ts';
import { runArguments } from '../scenarios/lib.ts';
import {
  BASELINE_FILE, BENCH_IMAGE, BENCH_INPUTS, BENCH_SCENARIO, compare, extractResult, formatReport, parseBenchArgs, summarize,
} from './lib.ts';
import type { Summary } from './lib.ts';

const MAIN_FILE = 'dist/bench/main.js';
const MAP_FILE = 'dist/bench/main.js.map';

/**
 * @description 在隔离容器中运行 bench 场景，输出原样转发到终端，同时收集标准输出供解析。
 * @returns 容器的标准输出。
 * @throws {Error} 无法启动 docker，或场景以非零状态退出。
 */
const runScenario = (): string => {
  const result = spawnSync('docker', runArguments(BENCH_IMAGE, { only: BENCH_SCENARIO }), {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  if (result.status !== 0) throw new Error(`bench 场景失败，退出状态 ${result.status}`);
  return result.stdout;
};

/**
 * @description 命令行主流程。
 * @returns 进程退出码：没有工作量改变与 CPU 回归为 0。
 * @throws {Error} 参数非法、构建失败、镜像构建失败、场景失败或结果无法解析。
 */
const main = (): number => {
  const args = parseBenchArgs(process.argv.slice(2));
  execFileSync('npm', ['run', 'build:bench'], { stdio: 'inherit' });
  const modules = collectModules(readFileSync(MAIN_FILE, 'utf8'), existsSync(MAP_FILE) ? readFileSync(MAP_FILE, 'utf8') : null);
  buildImage(BENCH_IMAGE, BENCH_INPUTS, modules);
  const current = summarize(extractResult(runScenario()));
  const baseline = existsSync(BASELINE_FILE) ? (JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Summary) : null;
  const { rows, failed } = compare(current, baseline, args.tolerance);
  console.log(formatReport(rows, current, baseline));
  if (args.update) {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`已写入基准文件 ${BASELINE_FILE}`);
    return 0;
  }
  if (baseline === null) console.log(`没有基准文件；确认结果后以 npm run bench -- --update 写入 ${BASELINE_FILE}`);
  if (failed) console.log('存在工作量改变或 CPU 回归；确认属于预期变化后以 --update 更新基准');
  return failed ? 1 : 0;
};

try {
  process.exitCode = main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
