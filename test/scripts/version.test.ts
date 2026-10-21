/**
 * 文件摘要：版本号规则（scripts/version/lib.ts）的单元测试。
 * 覆盖版本号解析、三种 bump 方式、构建产物判断（含 overrides，审计 PA-18），以及合并与普通提交的校验规则；
 * 合并按方向区分发布、集成与同步（PA-14）。
 */
import {
  checkVersion,
  classifyMerge,
  dependencyChanged,
  nextVersion,
  parseVersion,
  touchesBuildPaths,
} from '../../scripts/version/lib';

const v = parseVersion;

describe('parseVersion', () => {
  test('解析 a.b.c', () => {
    expect(v('0.12.3')).toEqual({ a: 0, b: 12, c: 3 });
  });
  test('拒绝预发布后缀与非法格式', () => {
    expect(() => v('0.2.0-dev.1')).toThrow();
    expect(() => v('1.2')).toThrow();
  });
});

describe('nextVersion', () => {
  test('task：c 加 1', () => {
    expect(nextVersion('task', v('0.1.0'))).toEqual(v('0.1.1'));
  });
  test('milestone：b 加 1，c 归零', () => {
    expect(nextVersion('milestone', v('0.1.7'))).toEqual(v('0.2.0'));
  });
  test('hotfix：取同一 a.b 下最大的 c 再加 1，避免与 dev 上已用的版本号重名', () => {
    expect(nextVersion('hotfix', v('0.2.5'), [v('0.2.8'), v('0.2.5')])).toEqual(v('0.2.9'));
  });
  test('hotfix：忽略其他里程碑的版本号', () => {
    expect(nextVersion('hotfix', v('0.2.5'), [v('0.3.1')])).toEqual(v('0.2.6'));
  });
});

describe('影响构建产物的判断', () => {
  test('src/ 与构建配置算作影响构建产物', () => {
    expect(touchesBuildPaths(['src/main.ts'])).toBe(true);
    expect(touchesBuildPaths(['rollup.config.mjs'])).toBe(true);
  });
  test('文档、测试与锁文件不算', () => {
    expect(touchesBuildPaths(['docs/design/architecture.md', 'test/a.test.ts', 'package-lock.json'])).toBe(false);
  });
  test('依赖声明变化算作影响构建产物', () => {
    expect(dependencyChanged({ devDependencies: { a: '1.0.0' } }, { devDependencies: { a: '1.0.1' } })).toBe(true);
    expect(dependencyChanged({ devDependencies: { a: '1.0.0' } }, { devDependencies: { a: '1.0.0' } })).toBe(false);
  });
  test('PA-18：overrides 变化同样算作依赖声明变化', () => {
    const overrides = { 'js-yaml@3': { argparse: '2.0.1' } };
    expect(dependencyChanged({}, { overrides })).toBe(true);
    expect(dependencyChanged({ overrides }, { overrides: { 'js-yaml@3': { argparse: '2.0.2' } } })).toBe(true);
    expect(dependencyChanged({ overrides }, { overrides: { 'js-yaml@3': { argparse: '2.0.1' } } })).toBe(false);
  });
});

describe('checkVersion', () => {
  const base = v('0.1.4');
  test('普通提交不改版本号', () => {
    expect(checkVersion({ merging: false, base, current: base, buildChanged: true }).ok).toBe(true);
    expect(checkVersion({ merging: false, base, current: v('0.1.5'), buildChanged: true }).ok).toBe(false);
  });
  test('不改变构建产物的合并不改版本号', () => {
    expect(checkVersion({ merging: true, base, current: base, buildChanged: false }).ok).toBe(true);
    expect(checkVersion({ merging: true, base, current: v('0.1.5'), buildChanged: false }).ok).toBe(false);
  });
  test('改变构建产物的合并必须增大版本号', () => {
    expect(checkVersion({ merging: true, base, current: base, buildChanged: true }).ok).toBe(false);
    expect(checkVersion({ merging: true, base, current: v('0.1.5'), buildChanged: true }).ok).toBe(true);
  });
  test('进入下一里程碑时 b 加 1、c 归零', () => {
    expect(checkVersion({ merging: true, base, current: v('0.2.0'), buildChanged: true }).ok).toBe(true);
    expect(checkVersion({ merging: true, base, current: v('0.2.3'), buildChanged: true }).ok).toBe(false);
  });
  test('a 的调整需要人工确认', () => {
    expect(checkVersion({ merging: true, base, current: v('1.0.0'), buildChanged: true }).ok).toBe(false);
  });
});

describe('PA-14：合并方向', () => {
  test('dev 的提交合并进 master 为发布；合并进 master 的其他提交与合并进 dev 为集成；其余为同步', () => {
    expect(classifyMerge({ branch: 'master', mergeHead: 'd1', devHead: 'd1' })).toBe('release');
    expect(classifyMerge({ branch: 'master', mergeHead: 'h1', devHead: 'd1' })).toBe('integrate');
    expect(classifyMerge({ branch: 'dev', mergeHead: 't1', devHead: 'd1' })).toBe('integrate');
    expect(classifyMerge({ branch: 'feat/x', mergeHead: 'd1', devHead: 'd1' })).toBe('sync');
    expect(classifyMerge({ branch: 'master', mergeHead: 'd1', devHead: null })).toBe('integrate');
  });
  test('发布保持 dev 的版本：跨里程碑的发布通过，发布时误 bump 被拒绝', () => {
    const release = { merging: true, base: v('0.1.11'), buildChanged: true, kind: 'release' as const, incoming: v('0.2.3') };
    expect(checkVersion({ ...release, current: v('0.2.3') }).ok).toBe(true);
    expect(checkVersion({ ...release, current: v('0.2.4') }).ok).toBe(false);
    expect(checkVersion({ ...release, base: v('0.1.5'), incoming: v('0.1.11'), current: v('0.1.12') }).ok).toBe(false);
  });
  test('同步取两个父提交中较大的版本', () => {
    const sync = { merging: true, buildChanged: true, kind: 'sync' as const };
    expect(checkVersion({ ...sync, base: v('0.1.11'), incoming: v('0.2.2'), current: v('0.2.2') }).ok).toBe(true);
    expect(checkVersion({ ...sync, base: v('0.2.2'), incoming: v('0.1.11'), current: v('0.2.2') }).ok).toBe(true);
    expect(checkVersion({ ...sync, base: v('0.1.11'), incoming: v('0.2.2'), current: v('0.1.11') }).ok).toBe(false);
  });
  test('发布与同步缺少被合并提交的版本号时抛错', () => {
    expect(() => checkVersion({ merging: true, base: v('0.1.0'), current: v('0.1.0'), buildChanged: false, kind: 'release' })).toThrow();
  });
});
