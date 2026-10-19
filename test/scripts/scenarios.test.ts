/**
 * 文件摘要：私服场景测试运行器纯函数（scripts/scenarios/lib.ts）的单元测试。
 * 覆盖：参数解析与场景名校验、构建上下文白名单不含仓库其余内容、容器运行参数的隔离项与场景过滤。
 */
import { IMAGE, STAGED_INPUTS, parseScenarioArgs, runArguments } from '../../scripts/scenarios/lib.ts';

test('参数：无参数运行全部场景，--only 指定单个场景', () => {
  expect(parseScenarioArgs([])).toEqual({});
  expect(parseScenarioArgs(['--only', 'kernel-smoke'])).toEqual({ only: 'kernel-smoke' });
});

test('参数：未知选项、位置参数与非法场景名都报错并附用法', () => {
  expect(() => parseScenarioArgs(['--jobs', '2'])).toThrow('用法');
  expect(() => parseScenarioArgs(['kernel-smoke'])).toThrow('用法');
  expect(() => parseScenarioArgs(['--only', '../secret'])).toThrow('场景名不合法');
  expect(() => parseScenarioArgs(['--only', 'Kernel_Smoke'])).toThrow('场景名不合法');
});

test('构建上下文只取自 test/scenarios，不含源码、产物目录或凭据', () => {
  for (const [source] of STAGED_INPUTS) expect(source.startsWith('test/scenarios/')).toBe(true);
  expect(STAGED_INPUTS.map(([, target]) => target)).toContain('Dockerfile');
});

test('容器运行参数：禁网、只读、去掉全部能力、非 root，场景过滤放在镜像名之后', () => {
  const args = runArguments(IMAGE, { only: 'memory-takeover' });
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000']) {
    expect(args).toContain(flag);
  }
  expect(args.some((arg) => arg.startsWith('--volume') || arg.startsWith('-v') || arg.startsWith('--env'))).toBe(false);
  expect(args.slice(args.indexOf(IMAGE))).toEqual([IMAGE, '--only', 'memory-takeover']);
  expect(runArguments(IMAGE, {}).at(-1)).toBe(IMAGE);
});
