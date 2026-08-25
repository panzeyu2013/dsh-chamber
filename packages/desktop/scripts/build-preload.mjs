#!/usr/bin/env node
/**
 * 将 packages/desktop/preload.cts 编译为纯 CJS（dist/preload.cjs）供打包与
 * dev 使用。
 *
 * 背景：沙箱 preload 在 Electron 的 sandbox bundle 中以纯 CJS 执行——没有
 * TypeScript 类型擦除，源码形态的 `import type` 会直接 SyntaxError
 * （Cannot use import statement outside a module）。因此 dev 与打包态统一
 * 加载编译产物（main.ts 缺省回退 .cts 源码，仅为源码检出兜底）。
 *
 * 编译隔离：tsconfig 只 include preload.cts，但 tsc 会把其本地 import 的
 * 类型来源文件一并纳入程序并整体 emit（preload.cts 的 3 个 type-only
 * import 会额外产出 ssh-config.js/transport-provider.js/updater.js 死文件，
 * 2026-09 打包闭包审计 P2-1）。因此先 emit 到临时目录再只搬入 preload.cjs，
 * 其余产物随目录删除——preload 必须保持自包含（仅 type-only 本地 import）；
 * 若未来引入运行时本地 import，请改为显式多文件打包而非依赖本清理。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
// Use the JS entry directly; do not make a distributable build depend on
// package-manager-specific `.bin` shim materialization.
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const project = path.join(desktopDir, 'tsconfig.preload.build.json');
const tempOut = path.join(desktopDir, 'dist', '.preload-build');
const entry = path.join(tempOut, 'preload.cjs');
const finalEntry = path.join(desktopDir, 'dist', 'preload.cjs');

if (!existsSync(tscEntry)) {
  console.error('[build-preload] 未找到 TypeScript。请先在仓库根目录执行 pnpm install。');
  process.exit(1);
}

mkdirSync(tempOut, { recursive: true });
const result = spawnSync(process.execPath, [tscEntry, '-p', project, '--outDir', tempOut], {
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
renameSync(entry, finalEntry);
rmSync(tempOut, { recursive: true, force: true });
console.log('[build-preload] preload 已编译为 CJS -> dist/preload.cjs');
