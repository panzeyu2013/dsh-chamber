#!/usr/bin/env node
/**
 * 将 packages/desktop/preload.cts 编译为纯 CJS（dist/preload.cjs）供打包与
 * dev 使用。
 *
 * 背景：沙箱 preload 在 Electron 的 sandbox bundle 中以纯 CJS 执行——没有
 * TypeScript 类型擦除，源码形态的 `import type` 会直接 SyntaxError
 * （Cannot use import statement outside a module）。因此 dev 与打包态统一
 * 加载编译产物（main.ts 缺省回退 .cts 源码，仅为源码检出兜底）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
// Use the JS entry directly; do not make a distributable build depend on
// package-manager-specific `.bin` shim materialization.
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const project = path.join(desktopDir, 'tsconfig.preload.build.json');
const entry = path.join(desktopDir, 'dist', 'preload.cjs');

if (!existsSync(tscEntry)) {
  console.error('[build-preload] 未找到 TypeScript。请先在仓库根目录执行 pnpm install。');
  process.exit(1);
}

const result = spawnSync(process.execPath, [tscEntry, '-p', project], {
  stdio: 'inherit',
  shell: false,
});
if (result.error || result.status !== 0) {
  console.error(`[build-preload] 编译失败（exit ${result.status ?? 'null'}）`);
  process.exit(result.status ?? 1);
}
if (!existsSync(entry)) {
  console.error(`[build-preload] 编译异常：${entry} 不存在`);
  process.exit(1);
}
console.log('[build-preload] preload 已编译为 CJS -> dist/preload.cjs');
