#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const DIST_INDEX = path.join(desktopDir, 'dist', 'index.html');
const forceBuild = process.argv.includes('--build');
const require = createRequire(import.meta.url);

function fail(message) {
  console.error(`[electron:dev] ${message}`);
  process.exit(1);
}

function resolveElectron() {
  for (const candidate of [
    path.join(repoRoot, 'node_modules', 'electron'),
    path.join(desktopDir, 'node_modules', 'electron'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const electronDir = resolveElectron();
if (electronDir === null) {
  fail('未找到 electron 二进制。请先在仓库根目录执行 pnpm install（.npmrc 已配置 electron_mirror，根 postinstall 自动补齐二进制）。');
}

if (forceBuild || !existsSync(DIST_INDEX)) {
  if (!forceBuild) {
    console.log('[electron:dev] 未找到渲染层构建产物 packages/desktop/dist/index.html，先执行 build:renderer');
  }
  const result = spawnSync('npm', ['run', 'build:renderer'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    fail(`渲染层构建失败（exit ${result.status ?? 'null'}）`);
  }
}

// 沙箱 preload 需要纯 CJS 编译产物（dist/preload.cjs，build:preload 生成）；
// 缺失时先编译（同 build:renderer 的懒构建模式）。
const PRELOAD_CJS = path.join(desktopDir, 'dist', 'preload.cjs');
if (!existsSync(PRELOAD_CJS)) {
  console.log('[electron:dev] 未找到 preload 编译产物 dist/preload.cjs，先执行 build:preload');
  const result = spawnSync('node', ['scripts/build-preload.mjs'], {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    fail(`preload 编译失败（exit ${result.status ?? 'null'}）`);
  }
}

// electron 43+ 的 macOS 产物只有 Electron.app（无 dist/electron 文件），
// 可执行路径以包导出的 path.txt 解析为准。
let electronExecutable;
try {
  electronExecutable = require('electron');
} catch {
  fail('electron 包不可解析（二进制缺失？）。请重跑 pnpm install 或 node scripts/ensure-electron.mjs');
}

const electron = spawn(electronExecutable, ['.'], {
  cwd: desktopDir,
  env: { ...process.env, DSH_CHAMBER_ELECTRON_DEV: '1' },
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGTERM');
      return;
    }
  } catch {}
  try {
    child.kill();
  } catch {}
}

let cleaning = false;
function onSignal(exitCode) {
  if (cleaning) return;
  cleaning = true;
  killTree(electron);
  const timer = setTimeout(() => process.exit(exitCode), 2000);
  electron.once('exit', () => {
    clearTimeout(timer);
    process.exit(exitCode);
  });
}

for (const [signal, exitCode] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 })) {
  process.on(signal, () => onSignal(exitCode));
}

electron.on('exit', (code, signal) => {
  console.log(`[electron:dev] electron 已退出（code ${code ?? 'null'} signal ${signal ?? 'none'}）`);
  process.exit(typeof code === 'number' ? code : 1);
});

electron.on('error', (err) => fail(`无法启动 electron：${err.message}`));
