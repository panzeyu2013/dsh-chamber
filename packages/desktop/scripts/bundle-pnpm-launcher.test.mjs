import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUNDLE_PNPM_INSTALL_ATTEMPTS, bundlePnpmLaunch, isTransientPnpmEagain, mergePnpmInstallOutput, pnpmInstallRetryEnv,
} from './bundle-pnpm-launcher.mjs';

test('bundle pnpm 启动形状：Windows 经 shell 解析 pnpm.cmd，POSIX 直接 exec', () => {
  assert.deepEqual(bundlePnpmLaunch('win32'), { command: 'pnpm', shell: true });
  assert.deepEqual(bundlePnpmLaunch('darwin'), { command: 'pnpm', shell: false });
  assert.deepEqual(bundlePnpmLaunch('linux'), { command: 'pnpm', shell: false });
});

test('bundle-dsh 的探测与执行共用同一形状（不再直启 pnpm.cmd）', () => {
  const source = readFileSync(new URL('./bundle-dsh.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /'pnpm\.cmd'/, '探测不得再直启 pnpm.cmd（win32 需要 shell 解析）');
  assert.match(source, /import \{[^}]*bundlePnpmLaunch[^}]*\} from '\.\/bundle-pnpm-launcher\.mjs'/);
  assert.equal(
    (source.match(/bundlePnpmLaunch\(\)/g) ?? []).length,
    3,
    '探测、通用 run 与安装重试各用一次 bundlePnpmLaunch()（同一平台感知形状）',
  );
});

test('EAGAIN classifier: only the transient pnpm failure is retried once', () => {
  assert.equal(BUNDLE_PNPM_INSTALL_ATTEMPTS, 2, 'the retry is bounded to one extra attempt');
  assert.equal(isTransientPnpmEagain('ERR_PNPM_EAGAIN  Failed to create hard link'), true);
  assert.equal(isTransientPnpmEagain('EAGAIN: resource temporarily unavailable'), true);
  assert.equal(isTransientPnpmEagain('ERR_PNPM_ENOSPC  no space left on device'), false);
  assert.equal(isTransientPnpmEagain('ERR_PNPM_FROZEN_LOCKFILE  lockfile mismatch'), false);
  assert.equal(isTransientPnpmEagain(''), false);
  assert.equal(isTransientPnpmEagain(undefined), false);
});

test('output merge keeps both pipes and makes stdout-only EAGAIN classifiable', () => {
  // pnpm may print the transient line on either stream; the classifier must see both.
  const stdoutOnly = mergePnpmInstallOutput('ERR_PNPM_EAGAIN  Failed to create hard link', '');
  assert.equal(isTransientPnpmEagain(stdoutOnly), true, 'stdout-only EAGAIN must be retried');
  const stderrOnly = mergePnpmInstallOutput('', 'EAGAIN: resource temporarily unavailable');
  assert.equal(isTransientPnpmEagain(stderrOnly), true, 'stderr-only EAGAIN must still be retried');
  const both = mergePnpmInstallOutput('progress 1/2', 'ERR_PNPM_EAGAIN  Failed to create hard link');
  assert.equal(isTransientPnpmEagain(both), true);
  assert.match(both, /progress 1\/2/, 'non-matching chunks are preserved for forwarding');
  assert.equal(isTransientPnpmEagain(mergePnpmInstallOutput('done', 'ERR_PNPM_ENOSPC  no space left on device')), false,
    'a non-transient failure is not retried');
  assert.equal(mergePnpmInstallOutput(undefined, undefined), '');
  assert.equal(mergePnpmInstallOutput('a', ''), 'a');
});

test('retry env flips the import method only on the retry attempt', () => {
  const base = { PATH: '/usr/bin', keep: 'yes' };
  assert.equal(pnpmInstallRetryEnv(1, base), base, 'the first attempt keeps the caller env untouched');
  const retry = pnpmInstallRetryEnv(2, base);
  assert.equal(retry.npm_config_package_import_method, 'hardlink', 'the retry pins hardlink imports');
  assert.equal(retry.PATH, '/usr/bin');
  assert.equal(retry.keep, 'yes');
  assert.equal(base.npm_config_package_import_method, undefined, 'the helper must not mutate the caller env');
});

test('bundle-dsh routes installs through the bounded EAGAIN retry on the merged output', () => {
  const source = readFileSync(new URL('./bundle-dsh.mjs', import.meta.url), 'utf8');
  assert.match(source, /function runPnpmInstall\(args, what\)/);
  assert.match(source, /stdio: \['inherit', 'pipe', 'pipe'\]/, 'both output pipes are captured while stdin stays interactive');
  assert.match(source, /maxBuffer: 64 \* 1024 \* 1024/, 'the capture cap is explicit (spawnSync default 1 MiB overflows on a large tree)');
  assert.match(source, /isTransientPnpmEagain\(mergePnpmInstallOutput\(result\.stdout, result\.stderr\)\)/,
    'classification reads stdout + stderr');
  assert.match(source, /process\.stdout\.write\(result\.stdout\)/, 'captured stdout is forwarded');
  assert.match(source, /process\.stderr\.write\(result\.stderr\)/, 'captured stderr is forwarded');
  assert.match(source, /env: pnpmInstallRetryEnv\(attempt\)/, 'the retry attempt carries the hardlink import env');
  // definition + the two install legs (lockfile refresh / frozen hoisted install).
  assert.equal((source.match(/runPnpmInstall\(/g) ?? []).length, 3);
  assert.doesNotMatch(source, /^run\($/m, 'install commands must not bypass the retry');
});
