/** 隔离边界回归：构建上下文不夹带宿主文件，执行参数不开放网络、凭据或目录挂载。 */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageContext, runArguments, main } from '../build/runIntegration.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'leviathan-context-test-'));
  const inputs = [
    'test/integration/runner/Dockerfile',
    'test/integration/runner/package.json',
    'test/integration/runner/package-lock.json',
    'test/integration/runner/.npmrc',
    'dist/main.js',
    'dist/main.js.map',
    'test/integration/scenarios/example.scenario.js',
    'test/integration/support/harness.js',
    'screeps-integration.config.cjs',
    '.secret.json',
    '.git/config',
    '.npmrc',
    'src/private.ts',
    'src/core/memoryManager/types.ts',
  ];
  for (const name of inputs) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), 'fixture');
  }
  writeFileSync(
    join(root, 'src/core/memoryManager/types.ts'),
    'export const SEGMENT_CAPACITY = 100_000;'
  );
  return root;
}

test('staging includes only runner inputs, never root config or credentials', () => {
  const root = fixture();
  const target = mkdtempSync(join(tmpdir(), 'leviathan-staged-test-'));
  try {
    stageContext(root, target);
    assert.ok(existsSync(join(target, 'dist/main.js')));
    assert.ok(existsSync(join(target, 'support/contract.json')));
    assert.ok(existsSync(join(target, 'scenarios/example.scenario.js')));
    for (const name of ['.secret.json', '.git', 'src'])
      assert.equal(existsSync(join(target, name)), false);
    assert.equal(existsSync(join(target, 'test')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('staging rejects a symlink inside an allowed input directory', () => {
  const root = fixture();
  const target = mkdtempSync(join(tmpdir(), 'leviathan-staged-test-'));
  try {
    symlinkSync(
      join(root, '.secret.json'),
      join(root, 'test/integration/scenarios/secret')
    );
    assert.throws(
      () => stageContext(root, target),
      /Unsupported integration input/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('runner locks down runtime privileges and rejects CLI escape options', () => {
  const args = runArguments('local-test-image', ['--only', 'runtime']);
  for (const flag of [
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=1000:1000',
  ])
    assert.ok(args.includes(flag));
  assert.equal(
    args.some((arg) =>
      /^(--mount|--volume|--env|--privileged|--publish)(=|$)/.test(arg)
    ),
    false
  );
  assert.deepEqual(args.slice(-3), ['local-test-image', '--only', 'runtime']);
  assert.throws(() => main(['--config', '/etc/other']), /Usage:/);
});
