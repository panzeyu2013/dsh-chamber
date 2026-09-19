import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundlePnpmLaunch } from './bundle-pnpm-launcher.mjs';

test('bundle pnpm 启动形状：Windows 经 shell 解析 pnpm.cmd，POSIX 直接 exec', () => {
  assert.deepEqual(bundlePnpmLaunch('win32'), { command: 'pnpm', shell: true });
  assert.deepEqual(bundlePnpmLaunch('darwin'), { command: 'pnpm', shell: false });
  assert.deepEqual(bundlePnpmLaunch('linux'), { command: 'pnpm', shell: false });
});

test('bundle-dsh 的探测与执行共用同一形状（不再直启 pnpm.cmd）', () => {
  const source = readFileSync(new URL('./bundle-dsh.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /'pnpm\.cmd'/, '探测不得再直启 pnpm.cmd（win32 需要 shell 解析）');
  assert.match(source, /import \{ bundlePnpmLaunch \} from '\.\/bundle-pnpm-launcher\.mjs'/);
  assert.equal(
    (source.match(/bundlePnpmLaunch\(\)/g) ?? []).length,
    2,
    '探测与执行必须各用一次 bundlePnpmLaunch()（同一平台感知形状）',
  );
});
