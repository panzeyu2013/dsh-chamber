#!/usr/bin/env node
/**
 * 将 @dsh-chamber/control-plane 的 TS 源码编译为纯 JS，供打包进 Electron 应用。
 *
 * 背景：Node 22.18+ 的类型擦除对 node_modules 下的文件不生效
 * （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），而 electron-builder 会把
 * workspace 依赖以 TS 源码形态放进 app.asar/node_modules。因此打包态必须
 * 使用编译产物（desktop/dist/control-plane/index.js）；开发态不受影响
 * （workspace 符号链接解析到真实路径，类型擦除正常）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const tscBin = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
const project = path.join(desktopDir, 'tsconfig.control-plane.build.json');
const entry = path.join(desktopDir, 'dist', 'control-plane', 'index.js');

if (!existsSync(tscBin)) {
  console.error('[build-control-plane] 未找到 tsc。请先在仓库根目录执行 npm install。');
  process.exit(1);
}

rmSync(path.join(desktopDir, 'dist', 'control-plane'), { recursive: true, force: true });

const result = spawnSync(tscBin, ['-p', project], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error || result.status !== 0) {
  console.error(`[build-control-plane] 编译失败（exit ${result.status ?? 'null'}）`);
  process.exit(result.status ?? 1);
}
if (!existsSync(entry)) {
  console.error(`[build-control-plane] 编译异常：${entry} 不存在`);
  process.exit(1);
}
console.log('[build-control-plane] control-plane 已编译为 JS -> dist/control-plane/');
