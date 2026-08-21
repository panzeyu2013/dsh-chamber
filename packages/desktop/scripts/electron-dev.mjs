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

// Dev-mode isolation: the dev instance must coexist with a running packaged
// dsh-chamber. The packaged app and a raw `electron .` share the same app
// identity (name "@dsh-chamber/desktop" → same userData), so a plain dev
// launch collides on the single-instance lock and on the default control-plane
// port 17500. The dev launcher therefore runs with its own user-data dir
// (own lock, state, registry, passwords — the packaged app's live state is
// never touched) and main.ts falls back to a dev control-plane port (17520,
// overridable via DSH_CHAMBER_CP_PORT) instead of 17500.
const DEV_USER_DATA_DIR = path.join(desktopDir, '.dev-user-data');

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

// The child env must never force Electron into node mode: a parent environment
// carrying ELECTRON_RUN_AS_NODE=1 (e.g. a shell launched from a
// node-in-electron runtime) would make the electron binary run as plain node —
// the main process would then resolve 'electron' to the npm launcher package
// and die on `import { app, BrowserWindow } from 'electron'`. The dev launcher
// always wants a real Electron app.
const childEnv = { ...process.env, DSH_CHAMBER_ELECTRON_DEV: '1' };
delete childEnv.ELECTRON_RUN_AS_NODE;

console.log(`[electron:dev] dev 隔离：user-data=${DEV_USER_DATA_DIR}（与打包版实例互不冲突；控制面端口见 main.ts 的 dev 默认值，可经 DSH_CHAMBER_CP_PORT 覆盖）`);

const electron = spawn(electronExecutable, [`--user-data-dir=${DEV_USER_DATA_DIR}`, '.'], {
  cwd: desktopDir,
  env: childEnv,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGTERM');
      // 升级兜底：launcher 是被监督进程（Electron）的监督者，退出必须确定性
      // 回收它——SIGTERM 1s 后仍活着则 SIGKILL 整个进程组，绝不留下无头
      // Electron（此前 SIGTERM 被 Chromium 消费/忽略时，2s 硬顶 process.exit
      // 会让 detached 的 Electron 残留在后台）。
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }
      }, 1000);
      escalate.unref?.();
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
