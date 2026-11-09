import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUNDLE_PNPM_INSTALL_ATTEMPTS, bundlePnpmLaunch, isTransientPnpmEagain } from './bundle-pnpm-launcher.mjs';

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

test('bundle-dsh routes installs through the bounded EAGAIN retry', () => {
  const source = readFileSync(new URL('./bundle-dsh.mjs', import.meta.url), 'utf8');
  assert.match(source, /function runPnpmInstall\(args, what\)/);
  assert.match(source, /isTransientPnpmEagain\(result\.stderr\)/);
  // definition + the two install legs (lockfile refresh / frozen hoisted install).
  assert.equal((source.match(/runPnpmInstall\(/g) ?? []).length, 3);
  assert.doesNotMatch(source, /^run\($/m, 'install commands must not bypass the retry');
});
